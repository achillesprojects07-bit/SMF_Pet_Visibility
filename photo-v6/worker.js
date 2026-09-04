const te = new TextEncoder();
let googleTokenCache = null;

function cors(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGIN || '').trim();
  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-SMF-Session,X-Upload-Id',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store'
  };
  if (!allowed || allowed === '*' || origin === allowed) h['Access-Control-Allow-Origin'] = allowed || '*';
  return h;
}
function json(request, env, body, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: {'Content-Type':'application/json; charset=utf-8', ...cors(request, env)}});
}
function nowIso(){ return new Date().toISOString(); }
function b64url(bytes){ let s=''; for(const b of new Uint8Array(bytes)) s+=String.fromCharCode(b); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function unb64url(s){ s=String(s||'').replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4)s+='='; const raw=atob(s), out=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i); return out; }
function q(v){ return String(v??'').replace(/'/g,"\\'"); }
function safeName(v){ return String(v||'').replace(/[\\/:*?"<>|\r\n]+/g,' ').replace(/\s+/g,' ').trim().slice(0,180) || 'Store'; }
function ext(name,mime){ const m=String(name||'').match(/\.([A-Za-z0-9]{2,5})$/); if(m)return m[1].toLowerCase(); mime=String(mime||'').toLowerCase(); if(mime.includes('png'))return'png'; if(mime.includes('webp'))return'webp'; if(mime.includes('heic'))return'heic'; if(mime.includes('heif'))return'heif'; return'jpg'; }

async function hmacKey(env){ return crypto.subtle.importKey('raw', te.encode(String(env.BRIDGE_SECRET||'')), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']); }
async function signSession(env, payload){ const body=JSON.stringify(payload); const key=await hmacKey(env); const sig=await crypto.subtle.sign('HMAC', key, te.encode(body)); return b64url(te.encode(body))+'.'+b64url(sig); }
async function verifySessionToken(env, token){ const [p,s]=String(token||'').split('.'); if(!p||!s)throw new Error('Field photo session is missing. Sign in again.'); const body=new TextDecoder().decode(unb64url(p)); const key=await hmacKey(env); const ok=await crypto.subtle.verify('HMAC',key,unb64url(s),te.encode(body)); if(!ok)throw new Error('Field photo session is invalid. Sign in again.'); const data=JSON.parse(body); if(Number(data.exp||0)<Date.now())throw new Error('Field photo session expired. Sign in again.'); return data; }

async function bridgeCall(env, action, args, timeoutMs=30000){
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetch(String(env.SCRIPT_API_URL||''),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bridgeSecret:String(env.BRIDGE_SECRET||''),action,args}),redirect:'follow',signal:controller.signal});
    const text=await r.text(); let data; try{data=JSON.parse(text)}catch(_){throw new Error('Login bridge returned an unreadable response.');}
    if(!r.ok||!data||data.ok===false)throw new Error(data?.error||'Login bridge failed.'); return data.result;
  } catch(err){ if(err?.name==='AbortError')throw new Error('Login service took too long. Please sign in again.'); throw err; }
  finally{clearTimeout(timer)}
}

async function createSession(request,env){
  const body=await request.json(), code=String(body.accessCode||'').trim(); if(!code)throw new Error('Access code is required.');
  const login=await bridgeCall(env,'loginV4',[code],20000); if(!login?.user||login.user.role!=='FIELD')throw new Error('Field access is required.');
  const home=await bridgeCall(env,'getFieldHomeV4',[code],30000); const stores=Array.isArray(home?.stores)?home.stores:[];
  const sid=crypto.randomUUID(); const storeMap={}; for(const s of stores){ if(!s?.key)continue; storeMap[String(s.key)]={key:String(s.key),name:String(s.name||''),storeId:String(s.storeId||''),team:String(s.team||home?.user?.team||login.user.team||''),area:String(s.area||''),category:String(s.category||''),guide:String(s.guide||'')}; }
  const exp=Date.now()+8*60*60*1000;
  await env.DB.prepare('INSERT OR REPLACE INTO photo_sessions (session_id,user_name,team,store_json,expires_at,created_at) VALUES (?,?,?,?,?,?)').bind(sid,String(login.user.name||home?.user?.name||'Field Team'),String(login.user.team||home?.user?.team||''),JSON.stringify(storeMap),exp,nowIso()).run();
  return {ok:true,sessionToken:await signSession(env,{sid,exp}),expiresAt:exp,user:{name:String(login.user.name||''),team:String(login.user.team||'')},storeCount:Object.keys(storeMap).length};
}
async function requireSession(request,env){
  const payload=await verifySessionToken(env,request.headers.get('X-SMF-Session')||'');
  const row=await env.DB.prepare('SELECT user_name,team,store_json,expires_at FROM photo_sessions WHERE session_id=?').bind(payload.sid).first();
  if(!row||Number(row.expires_at||0)<Date.now())throw new Error('Field photo session expired. Sign in again.');
  return {sid:payload.sid,userName:String(row.user_name||''),team:String(row.team||''),stores:JSON.parse(row.store_json||'{}')};
}
function requireStoreAccess(session,tx){ const store=session.stores[String(tx?.store_key||'')]; if(!store)throw new Error('This photo belongs to a store that is not assigned to the signed-in field team.'); return store; }

async function googleAccessToken(env){
  if(googleTokenCache&&googleTokenCache.exp>Date.now()+60000)return googleTokenCache.token;
  const clientId=String(env.GOOGLE_OAUTH_CLIENT_ID||'').trim();
  const clientSecret=String(env.GOOGLE_OAUTH_CLIENT_SECRET||'').trim();
  const refreshToken=String(env.GOOGLE_OAUTH_REFRESH_TOKEN||'').trim();
  if(!clientId||!clientSecret||!refreshToken)throw new Error('Google My Drive OAuth credentials are not configured.');
  const r=await fetch('https://oauth2.googleapis.com/token',{
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken,grant_type:'refresh_token'})
  });
  const d=await r.json();
  if(!r.ok||!d.access_token)throw new Error('Google My Drive OAuth refresh failed. Re-authorize the SMF backend.');
  googleTokenCache={token:d.access_token,exp:Date.now()+Number(d.expires_in||3300)*1000};
  return d.access_token;
}
async function gfetch(env,url,init={}){ const token=await googleAccessToken(env); return fetch(url,{...init,headers:{...(init.headers||{}),Authorization:`Bearer ${token}`}}); }

async function findFolder(env,parentId,name){ const query=`'${q(parentId)}' in parents and name='${q(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`; const r=await gfetch(env,`https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=2&fields=files(id,name)&q=${encodeURIComponent(query)}`); const d=await r.json(); if(!r.ok)throw new Error('Drive folder lookup failed.'); return d.files?.[0]||null; }
function normFolderName(v){ return String(v||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[–—]/g,'-').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' '); }
async function listChildFolders(env,parentId){ const query=`'${q(parentId)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`; const r=await gfetch(env,`https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1000&fields=files(id,name)&q=${encodeURIComponent(query)}`); const d=await r.json(); if(!r.ok)throw new Error('Drive folder lookup failed.'); return d.files||[]; }
async function findFolderFlexible(env,parentId,candidates){
  for(const raw of candidates){ const name=safeName(raw); if(!name)continue; const exact=await findFolder(env,parentId,name); if(exact)return exact; }
  const kids=await listChildFolders(env,parentId), norms=candidates.map(normFolderName).filter(Boolean);
  for(const k of kids){ const nk=normFolderName(k.name); if(norms.includes(nk))return k; }
  return null;
}
async function resolveStoreFolder(env,store){
  let parent=String(env.POE_ROOT_FOLDER_ID||''); if(!parent)throw new Error('POE root folder is not configured.');
  const fixed=[String(env.SMF_MODE||'LIVE'),safeName(store.team),safeName(store.area)];
  for(const n of fixed){ const f=await findFolderFlexible(env,parent,[n]); if(!f)throw new Error('Existing POE folder not found: '+n+'. Upload was not started.'); parent=f.id; }
  const storeName=safeName(store.name), storeId=safeName(store.storeId);
  const candidates=[]; if(storeId)candidates.push(storeId+' - '+storeName); candidates.push(storeName);
  let f=await findFolderFlexible(env,parent,candidates);
  if(!f){
    const kids=await listChildFolders(env,parent), nn=normFolderName(storeName), ni=normFolderName(storeId);
    f=kids.find(k=>{ const nk=normFolderName(k.name); return (ni&&nk.includes(ni)&&nk.includes(nn)) || (nn&&nk.endsWith(nn)); })||null;
  }
  if(!f)throw new Error('Existing POE folder not found for '+storeName+'. Upload was not started.');
  return f.id;
}
async function createDriveShell(env,folderId,fileName,mime,uploadId){ const r=await gfetch(env,'https://www.googleapis.com/drive/v3/files?fields=id,name,size,mimeType,webViewLink,parents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:fileName,mimeType:mime||'image/jpeg',parents:[folderId],appProperties:{smfUploadId:uploadId,smfTransport:'V6_DIRECT_OAUTH'}})}); const d=await r.json(); if(!r.ok||!d.id)throw new Error('Drive could not reserve the photo file.'); return d; }
async function uploadDrive(env,fileId,body,mime){ const r=await gfetch(env,`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,size,mimeType,webViewLink,parents`,{method:'PATCH',headers:{'Content-Type':mime||'application/octet-stream'},body}); const d=await r.json(); if(!r.ok||!d.id||Number(d.size||0)<=0)throw new Error('Drive did not confirm the photo bytes.'); return d; }

async function sheetValues(env,range){ const r=await gfetch(env,`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEET_ID)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`); const d=await r.json(); if(!r.ok)throw new Error('Google Sheets read failed.'); return d.values||[]; }
async function sheetAppend(env,range,row){ const r=await gfetch(env,`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEET_ID)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({values:[row]})}); if(!r.ok)throw new Error('Google Sheets append failed.'); return r.json(); }
async function sheetUpdate(env,range,values){ const r=await gfetch(env,`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.GOOGLE_SHEET_ID)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({values})}); if(!r.ok)throw new Error('Google Sheets update failed.'); return r.json(); }
function colA1(n){let s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s;}
async function syncPhotoRow(env,tx,store,userName){
  const rows=await sheetValues(env,'V4_PHOTOS'); if(!rows.length)throw new Error('V4_PHOTOS has no header row.'); const headers=rows[0].map(String), idx={}; headers.forEach((h,i)=>idx[h]=i); const required=['Environment','Store Key','Store Name','Team','Photo Type','File ID','File Name','File URL','Folder ID','Active','Uploaded At','Uploaded By','Guide Used','Notes']; for(const h of required)if(idx[h]===undefined)throw new Error('V4_PHOTOS is missing column: '+h);
  const marker='V6_UPLOAD:'+tx.upload_id; let duplicateRow=0; for(let i=1;i<rows.length;i++){ if(String(rows[i][idx['Notes']]||'')===marker && String(rows[i][idx['Store Key']]||'')===tx.store_key){duplicateRow=i+1;break;} }
  if(!duplicateRow){ const out=new Array(headers.length).fill(''); const set=(h,v)=>out[idx[h]]=v; set('Environment',String(env.SMF_MODE||'LIVE').toUpperCase());set('Store Key',tx.store_key);set('Store Name',store.name);set('Team',store.team);set('Photo Type',tx.photo_type);set('File ID',tx.file_id);set('File Name',tx.file_name);set('File URL',tx.file_url);set('Folder ID',tx.folder_id);set('Active',true);set('Uploaded At',nowIso());set('Uploaded By',userName);set('Guide Used',store.guide||'');set('Notes',marker); await sheetAppend(env,'V4_PHOTOS!A:ZZ',out); }
  if(!Number(tx.is_extra||0)){
    const activeCol=idx['Active']+1, notesCol=idx['Notes']+1; for(let i=1;i<rows.length;i++){ const r=rows[i]; if(String(r[idx['Environment']]||'').toUpperCase()!==String(env.SMF_MODE||'LIVE').toUpperCase())continue; if(String(r[idx['Store Key']]||'')!==tx.store_key)continue; if(String(r[idx['Photo Type']]||'')!==tx.photo_type)continue; if(String(r[idx['File ID']]||'')===tx.file_id)continue; const active=String(r[idx['Active']]??'').toLowerCase(); if(active==='true'||active==='1'||active==='yes'){ await sheetUpdate(env,`V4_PHOTOS!${colA1(activeCol)}${i+1}:${colA1(notesCol)}${i+1}`,[[false,...new Array(notesCol-activeCol-1).fill(''),'Replaced by V6 upload '+tx.upload_id+' at '+nowIso()]]); } }
  }
  return {duplicate:!!duplicateRow,row:duplicateRow||null};
}

async function preflight(request,env){ const session=await requireSession(request,env); const b=await request.json(); const store=session.stores[String(b.storeKey||'')]; if(!store)throw new Error('This store is not assigned to the signed-in field team.'); const uploadId=String(b.uploadId||crypto.randomUUID()); const existing=await env.DB.prepare('SELECT * FROM photo_uploads WHERE upload_id=?').bind(uploadId).first(); if(existing){requireStoreAccess(session,existing);return {ok:true,uploadId,status:existing.status,fileId:existing.file_id||'',fileName:existing.file_name||'',folderId:existing.folder_id||'',alreadyExists:true};} const mime=String(b.mime||'image/jpeg'), size=Number(b.size||0); if(size<=0||size>12*1024*1024)throw new Error('Photo size is not supported.'); if(mime&&!mime.startsWith('image/'))throw new Error('Only image files are supported.'); const isExtra=b.addAnother?1:0, baseType=String(b.photoType||'').trim().toUpperCase(); if(!baseType)throw new Error('Photo type is required.'); const photoType=isExtra?`EXTRA__${baseType}__${uploadId.replace(/[^A-Za-z0-9]/g,'').slice(0,8)}`:baseType; const folderId=await resolveStoreFolder(env,store); const fileName=safeName(store.name)+'_'+photoType+'_'+uploadId.replace(/[^A-Za-z0-9]/g,'').slice(0,12)+'.'+ext(b.originalName,mime); const shell=await createDriveShell(env,folderId,fileName,mime,uploadId); const ts=nowIso(); await env.DB.prepare('INSERT INTO photo_uploads (upload_id,session_id,store_key,photo_type,base_type,is_extra,file_id,folder_id,file_name,file_url,mime,bytes,status,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(uploadId,session.sid,store.key,photoType,baseType,isExtra,shell.id,folderId,fileName,shell.webViewLink||'',mime,0,'RESERVED','',ts,ts).run(); return {ok:true,uploadId,fileId:shell.id,fileName,folderId,status:'RESERVED'}; }
async function upload(request,env,uploadId){ const session=await requireSession(request,env); const tx=await env.DB.prepare('SELECT * FROM photo_uploads WHERE upload_id=?').bind(uploadId).first(); if(!tx)throw new Error('Upload reservation was not found.'); const store=requireStoreAccess(session,tx); if(tx.status==='COMPLETE')return {ok:true,status:'COMPLETE',fileId:tx.file_id,url:tx.file_url,name:tx.file_name,bytes:Number(tx.bytes||0)}; if((tx.status==='DRIVE_SAVED'||tx.status==='METADATA_PENDING')&&Number(tx.bytes||0)>0){try{await syncPhotoRow(env,tx,store,session.userName);await env.DB.prepare('UPDATE photo_uploads SET status=?,updated_at=?,error=? WHERE upload_id=?').bind('COMPLETE',nowIso(),'',uploadId).run();return {ok:true,status:'COMPLETE',fileId:tx.file_id,url:tx.file_url,name:tx.file_name,bytes:Number(tx.bytes||0)};}catch(err){await env.DB.prepare('UPDATE photo_uploads SET status=?,updated_at=?,error=? WHERE upload_id=?').bind('METADATA_PENDING',nowIso(),String(err?.message||err),uploadId).run();return {ok:true,status:'METADATA_PENDING',fileId:tx.file_id,url:tx.file_url,name:tx.file_name,bytes:Number(tx.bytes||0),message:'Photo is safe in Drive. Metadata will retry without re-uploading the image.'};}} const len=Number(request.headers.get('Content-Length')||0); if(len>12*1024*1024)throw new Error('Photo is over 12 MB.'); const drive=await uploadDrive(env,tx.file_id,request.body,request.headers.get('Content-Type')||tx.mime); const ts=nowIso(); await env.DB.prepare('UPDATE photo_uploads SET bytes=?,file_url=?,status=?,updated_at=?,error=? WHERE upload_id=?').bind(Number(drive.size||0),String(drive.webViewLink||''),'DRIVE_SAVED',ts,'',uploadId).run(); try{ await syncPhotoRow(env,{...tx,file_url:String(drive.webViewLink||''),bytes:Number(drive.size||0)},store,session.userName); await env.DB.prepare('UPDATE photo_uploads SET status=?,updated_at=?,error=? WHERE upload_id=?').bind('COMPLETE',nowIso(),'',uploadId).run(); return {ok:true,status:'COMPLETE',fileId:tx.file_id,url:String(drive.webViewLink||''),name:tx.file_name,bytes:Number(drive.size||0)}; }catch(err){ await env.DB.prepare('UPDATE photo_uploads SET status=?,updated_at=?,error=? WHERE upload_id=?').bind('METADATA_PENDING',nowIso(),String(err?.message||err),uploadId).run(); return {ok:true,status:'METADATA_PENDING',fileId:tx.file_id,url:String(drive.webViewLink||''),name:tx.file_name,bytes:Number(drive.size||0),message:'Photo is safe in Drive. Metadata will retry without re-uploading the image.'}; } }
async function retrySync(request,env,uploadId){ const session=await requireSession(request,env); const tx=await env.DB.prepare('SELECT * FROM photo_uploads WHERE upload_id=?').bind(uploadId).first(); if(!tx)throw new Error('Upload transaction was not found.'); const store=requireStoreAccess(session,tx); if(tx.status==='COMPLETE')return {ok:true,status:'COMPLETE',fileId:tx.file_id,url:tx.file_url,name:tx.file_name}; if(!tx.file_id||Number(tx.bytes||0)<=0)throw new Error('Drive has not confirmed this photo yet.'); await syncPhotoRow(env,tx,store,session.userName); await env.DB.prepare('UPDATE photo_uploads SET status=?,updated_at=?,error=? WHERE upload_id=?').bind('COMPLETE',nowIso(),'',uploadId).run(); return {ok:true,status:'COMPLETE',fileId:tx.file_id,url:tx.file_url,name:tx.file_name}; }
async function status(request,env,uploadId){ const session=await requireSession(request,env); const tx=await env.DB.prepare('SELECT upload_id,store_key,status,file_id,file_url,file_name,bytes,error,updated_at FROM photo_uploads WHERE upload_id=?').bind(uploadId).first(); if(!tx)throw new Error('Upload transaction was not found.'); requireStoreAccess(session,tx); return {ok:true,...tx}; }
async function readiness(env){
  await googleAccessToken(env);
  const rootId=String(env.POE_ROOT_FOLDER_ID||''); if(!rootId)throw new Error('POE root folder is not configured.');
  const rr=await gfetch(env,`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(rootId)}?fields=id,name,mimeType,trashed`); const rd=await rr.json(); if(!rr.ok||rd.trashed||rd.mimeType!=='application/vnd.google-apps.folder')throw new Error('POE root folder is not available to the Google OAuth account.');
  const rows=await sheetValues(env,'V4_PHOTOS!1:1'); if(!rows.length)throw new Error('V4_PHOTOS header row is unavailable.'); const headers=rows[0].map(String); const required=['Environment','Store Key','Store Name','Team','Photo Type','File ID','File Name','File URL','Folder ID','Active','Uploaded At','Uploaded By','Guide Used','Notes']; const missing=required.filter(h=>!headers.includes(h)); if(missing.length)throw new Error('V4_PHOTOS is missing columns: '+missing.join(', '));
  return {ok:true,service:'SMF_PHOTO_V6',version:'6.0.3-folder-compatible',directGoogle:true,googleAuth:'oauth-refresh-token',appsScriptPhotoPath:false,driveRoot:{id:rd.id,name:rd.name},sheet:'V4_PHOTOS',requiredColumnsOk:true,folderPattern:'LIVE / Team / Area / (Store ID - Store Name OR Store Name)',createsFolders:false};
}

export default { async fetch(request,env){
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors(request,env)});
  try{
    if(!env.DB)throw new Error('Photo transaction database is not configured.');
    const url=new URL(request.url), path=url.pathname;
    if(path==='/v6/health'&&request.method==='GET')return json(request,env,{ok:true,service:'SMF_PHOTO_V6',version:'6.0.3-folder-compatible',directGoogle:true,googleAuth:'oauth-refresh-token',appsScriptPhotoPath:false});
    if(path==='/v6/ready'&&request.method==='GET')return json(request,env,await readiness(env));
    if(path==='/v6/session'&&request.method==='POST')return json(request,env,await createSession(request,env));
    if(path==='/v6/photo/preflight'&&request.method==='POST')return json(request,env,await preflight(request,env));
    let m=path.match(/^\/v6\/photo\/([^/]+)$/); if(m&&request.method==='PUT')return json(request,env,await upload(request,env,decodeURIComponent(m[1])));
    m=path.match(/^\/v6\/photo\/([^/]+)\/sync$/); if(m&&request.method==='POST')return json(request,env,await retrySync(request,env,decodeURIComponent(m[1])));
    m=path.match(/^\/v6\/photo\/([^/]+)\/status$/); if(m&&request.method==='GET')return json(request,env,await status(request,env,decodeURIComponent(m[1])));
    return json(request,env,{ok:false,error:'Not found.'},404);
  }catch(err){return json(request,env,{ok:false,error:String(err?.message||err)},400)}
}};
