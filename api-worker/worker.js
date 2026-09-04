let cachedGoogleToken = null;

const ACTION_ALLOWLIST = new Set([
  'loginV4',
  'getFieldHomeV4','getStoreV4','saveStoreV4','submitStoreVisitV4','submitDayV4','removePhotoV4','rescheduleStoreV4',
  'getClientDashboardV4','getClientStoreV4',
  'getAdminDashboardV4','getAdminIssuesV4','getPoeIndexV4','getAdminStoreV4','reopenStoreVisitV4',
  'getUsersV4','createUserV4','setUserActiveV4','setUserTeamV4','resetUserCodeV4',
  'getRulesV4','setStoreGuideV4','setCategoryGuideV4','getSystemV4','photoUploadHealthV4','healthV4','createOrResetClientAccessV4'
]);
const SAFE_BRIDGE_RETRY = new Set([
  'getBridgeHealthV5','getDriveUploadTokenV5','prepareExternalPhotoUploadV5','prepareExternalPhotoV5','commitExternalPhotoFastV5',
  'loginV4','getFieldHomeV4','getStoreV4','getClientDashboardV4','getClientStoreV4',
  'getAdminDashboardV4','getAdminIssuesV4','getPoeIndexV4','getAdminStoreV4','getUsersV4','getRulesV4','getSystemV4','photoUploadHealthV4','healthV4'
]);
const LONG_READ_ACTIONS = new Set([
  'getFieldHomeV4','getStoreV4','getClientDashboardV4','getClientStoreV4',
  'getAdminDashboardV4','getAdminIssuesV4','getPoeIndexV4','getAdminStoreV4','getUsersV4','getRulesV4','getSystemV4'
]);
const WRITE_ACTIONS = new Set([
  'saveStoreV4','submitStoreVisitV4','submitDayV4','removePhotoV4','rescheduleStoreV4',
  'reopenStoreVisitV4','createUserV4','setUserActiveV4','setUserTeamV4','resetUserCodeV4',
  'setStoreGuideV4','setCategoryGuideV4','createOrResetClientAccessV4'
]);
const TOKEN_WARM_ACTIONS = new Set(['loginV4','getFieldHomeV4','getStoreV4']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const te = new TextEncoder();
const td = new TextDecoder();

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGIN || '').trim();
  const allowOrigin = (!allowed || allowed === '*') ? '*' : (origin === allowed ? origin : '');
  const h = {'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'86400','Cache-Control':'no-store'};
  if (allowOrigin) h['Access-Control-Allow-Origin'] = allowOrigin;
  return h;
}
function jsonResponse(request, env, body, status = 200) {return new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json; charset=utf-8',...corsHeaders(request, env)}});}
function assertOrigin(request, env) {const allowed=String(env.ALLOWED_ORIGIN||'').trim();if(!allowed||allowed==='*')return;if((request.headers.get('Origin')||'')!==allowed)throw new Error('Origin is not allowed.');}
async function bridgeFetchOnce(env, action, args, timeoutMs = 8000) {
  const url=String(env.SCRIPT_API_URL||'').trim(),secret=String(env.BRIDGE_SECRET||'').trim();if(!url||!secret)throw new Error('API bridge is not configured.');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);let r;
  try{r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bridgeSecret:secret,action,args}),redirect:'follow',signal:controller.signal});}
  catch(err){if(err&&err.name==='AbortError')throw new Error('Apps Script bridge timed out.');throw new Error('Apps Script bridge connection failed.');}
  finally{clearTimeout(timer);}
  const text=await r.text();let data;
  try{data=JSON.parse(text);}catch(_){const type=String(r.headers.get('content-type')||'').toLowerCase();if(!r.ok)throw new Error('Apps Script bridge returned HTTP '+r.status+'.');if(type.includes('text/html'))throw new Error('Apps Script bridge returned HTML instead of JSON.');throw new Error('Apps Script bridge returned an unreadable response.');}
  if(!r.ok||!data||data.ok===false)throw new Error((data&&data.error)||('Apps Script bridge failed (HTTP '+r.status+').'));return data.result;
}
async function callAppsScript(env,action,args,options={}){const safe=SAFE_BRIDGE_RETRY.has(action),retries=Number.isInteger(options.retries)?options.retries:(safe?1:0),timeoutMs=Number(options.timeoutMs||8000);let lastErr;for(let attempt=0;attempt<=retries;attempt++){try{return await bridgeFetchOnce(env,action,args,timeoutMs)}catch(err){lastErr=err;if(attempt>=retries)break;await sleep(400*(attempt+1))}}throw lastErr||new Error('Apps Script bridge failed.');}
function tokenCacheUrl(){return 'https://smf-token.invalid/google-drive-oauth-v1';}
async function readCachedGoogleToken(){try{const r=await caches.default.match(tokenCacheUrl());if(!r)return null;const d=await r.json();if(!d||!d.token||Number(d.expiresAt||0)<=Date.now()+60000)return null;return d}catch(_){return null}}
async function rememberGoogleToken(token,expiresAt){token=String(token||'');if(!token)return;const record={token,expiresAt:Number(expiresAt||Date.now()+45*60*1000)};cachedGoogleToken=record;try{await caches.default.put(tokenCacheUrl(),new Response(JSON.stringify(record),{headers:{'Content-Type':'application/json','Cache-Control':'max-age=2700'}}))}catch(_){}}
async function getGoogleAccessToken(env,forceFresh=false){const now=Date.now();if(!forceFresh&&cachedGoogleToken&&cachedGoogleToken.expiresAt>now+60000)return cachedGoogleToken.token;if(!forceFresh){const persisted=await readCachedGoogleToken();if(persisted){cachedGoogleToken=persisted;return persisted.token}}const r=await callAppsScript(env,'getDriveUploadTokenV5',[],{retries:2,timeoutMs:15000}),token=String(r&&r.accessToken||'');if(!token)throw new Error('Apps Script did not provide a Google Drive upload token.');await rememberGoogleToken(token,now+45*60*1000);return token;}
async function warmGoogleAccessToken(env){try{return await getGoogleAccessToken(env,false)}catch(_){return null}}
async function driveFetch(env,url,init={},retry401=true){let token=await getGoogleAccessToken(env,false);let r=await fetch(url,{...init,headers:{...(init.headers||{}),Authorization:`Bearer ${token}`}});if(r.status===401&&retry401){token=await getGoogleAccessToken(env,true);r=await fetch(url,{...init,headers:{...(init.headers||{}),Authorization:`Bearer ${token}`}})}return r;}
async function getDriveFile(env,fileId){const r=await driveFetch(env,`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,parents`),data=await r.json();if(!r.ok||!data.id)throw new Error('Could not verify the reserved Google Drive photo file.');return data;}
async function createDriveFile(env,folderId,fileName,mime){const r=await driveFetch(env,'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,parents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:fileName,mimeType:mime||'image/jpeg',parents:[folderId]})}),data=await r.json();if(!r.ok||!data.id)throw new Error('Google Drive could not reserve the photo file.');return data;}
async function uploadDriveMedia(env,fileId,file,mime){const r=await driveFetch(env,`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,parents`,{method:'PATCH',headers:{'Content-Type':mime||file.type||'application/octet-stream'},body:file.stream()}),data=await r.json();if(!r.ok||!data.id)throw new Error('Google Drive did not finish saving the photo.');return data;}
async function ensureDrivePhoto(env,prep,file){let fileId=String(prep&&prep.fileId||'');if(!fileId){if(!prep?.folderId||!prep?.fileName)throw new Error('Apps Script did not authorize a Drive folder for this upload.');const shell=await createDriveFile(env,String(prep.folderId),String(prep.fileName),prep.mime||file.type);fileId=String(shell.id||'');}
  let existing=await getDriveFile(env,fileId);const currentSize=Number(existing.size||0);if(currentSize!==Number(file.size||0)||currentSize===0)existing=await uploadDriveMedia(env,fileId,file,prep.mime||file.type);if(Number(existing.size||file.size||0)<=0)throw new Error('Google Drive did not confirm the photo bytes.');return existing;}
function actionBridgeOptions(action){
  if(action==='loginV4')return {retries:0,timeoutMs:20000};
  if(LONG_READ_ACTIONS.has(action))return {retries:0,timeoutMs:30000};
  if(WRITE_ACTIONS.has(action))return {retries:0,timeoutMs:25000};
  return {retries:0,timeoutMs:20000};
}
async function handleAction(request,env,ctx){const body=await request.json(),action=String(body.action||'');if(!ACTION_ALLOWLIST.has(action))throw new Error('API action is not allowed.');const result=await callAppsScript(env,action,Array.isArray(body.args)?body.args:[],actionBridgeOptions(action));if(TOKEN_WARM_ACTIONS.has(action)&&ctx&&ctx.waitUntil)ctx.waitUntil(warmGoogleAccessToken(env));return result;}
async function confirmPhotoMetadata(env,code,p){return await callAppsScript(env,'commitExternalPhotoFastV5',[code,p],{retries:0,timeoutMs:25000});}

async function resumeKey(env){return await crypto.subtle.importKey('raw',te.encode(String(env.BRIDGE_SECRET||'')),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
function resumeBody(code,commitPayload){return JSON.stringify({accessCode:String(code||''),commitPayload:commitPayload||{}});}
function b64url(bytes){let s='';for(const b of new Uint8Array(bytes))s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function unb64url(s){s=String(s||'').replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';const raw=atob(s),a=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)a[i]=raw.charCodeAt(i);return a;}
async function signResume(env,code,commitPayload){const key=await resumeKey(env),body=resumeBody(code,commitPayload),sig=await crypto.subtle.sign('HMAC',key,te.encode(body));return {accessCode:code,commitPayload,signature:b64url(sig)};}
async function verifyResume(env,resume){if(!resume||!resume.signature)throw new Error('Photo sync authorization is missing.');const key=await resumeKey(env),body=resumeBody(resume.accessCode,resume.commitPayload),ok=await crypto.subtle.verify('HMAC',key,unb64url(resume.signature),te.encode(body));if(!ok)throw new Error('Photo sync authorization failed.');return resume;}

async function aesKey(env){const digest=await crypto.subtle.digest('SHA-256',te.encode('SMF_UPLOAD_TOKEN|'+String(env.BRIDGE_SECRET||'')));return crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['encrypt','decrypt']);}
async function sealText(env,text){const key=await aesKey(env),iv=crypto.getRandomValues(new Uint8Array(12)),ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,te.encode(String(text||'')));return b64url(iv)+'.'+b64url(ct);}
async function openText(env,sealed){const parts=String(sealed||'').split('.');if(parts.length!==2)throw new Error('Upload credential is invalid.');const key=await aesKey(env),pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64url(parts[0])},key,unb64url(parts[1]));return td.decode(pt);}
function preflightBody(payload){return JSON.stringify(payload||{});}
async function signPreflight(env,payload){const key=await resumeKey(env),sig=await crypto.subtle.sign('HMAC',key,te.encode(preflightBody(payload)));return {payload,signature:b64url(sig)};}
async function verifyPreflight(env,ticket){if(!ticket||!ticket.payload||!ticket.signature)throw new Error('Photo upload preflight is missing.');const key=await resumeKey(env),ok=await crypto.subtle.verify('HMAC',key,unb64url(ticket.signature),te.encode(preflightBody(ticket.payload)));if(!ok)throw new Error('Photo upload preflight authorization failed.');if(Number(ticket.payload.expiresAt||0)<Date.now())throw new Error('Photo upload preflight expired. Please choose the photo again.');return ticket.payload;}

function safeExt(name,mime){const m=String(name||'').match(/\.([A-Za-z0-9]{2,5})$/);if(m)return m[1].toLowerCase();mime=String(mime||'').toLowerCase();if(mime.includes('png'))return'png';if(mime.includes('webp'))return'webp';if(mime.includes('heic'))return'heic';if(mime.includes('heif'))return'heif';return'jpg';}
function qEsc(v){return String(v||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");}
async function findPendingFile(env,uploadToken){const q=`appProperties has { key='smfUploadToken' and value='${qEsc(uploadToken)}' } and trashed=false`;const r=await driveFetch(env,`https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=2&fields=files(id,name,mimeType,size,webViewLink,parents)&q=${encodeURIComponent(q)}`),d=await r.json();if(!r.ok)throw new Error('Google Drive could not check the pending photo slot.');return Array.isArray(d.files)&&d.files.length?d.files[0]:null;}
async function createPendingFile(env,p){let f=await findPendingFile(env,p.uploadToken);if(f)return f;const ext=safeExt(p.originalName,p.mime),name=`SMF_PENDING_${String(p.uploadToken||'').replace(/[^A-Za-z0-9_-]/g,'').slice(0,48)}.${ext}`;const r=await driveFetch(env,'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,parents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,mimeType:p.mime||'image/jpeg',appProperties:{smfUploadToken:String(p.uploadToken||''),smfStoreKey:String(p.storeKey||''),smfPhotoType:String(p.photoType||'')}})}),d=await r.json();if(!r.ok||!d.id)throw new Error('Google Drive could not create the safe photo slot.');return d;}
async function moveDriveFile(env,fileId,folderId,fileName){const before=await getDriveFile(env,fileId),parents=Array.isArray(before.parents)?before.parents:[];let url=`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,parents&addParents=${encodeURIComponent(folderId)}`;if(parents.length)url+=`&removeParents=${encodeURIComponent(parents.join(','))}`;const r=await driveFetch(env,url,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:fileName})}),d=await r.json();if(!r.ok||!d.id)throw new Error('Google Drive saved the photo but could not place it in the store folder yet.');return d;}
function syncUrl(token){return 'https://smf-sync.invalid/'+encodeURIComponent(String(token||''));}
async function readSyncState(token){try{const r=await caches.default.match(syncUrl(token));return r?await r.json():null}catch(_){return null}}
async function writeSyncState(token,state){try{await caches.default.put(syncUrl(token),new Response(JSON.stringify(state),{headers:{'Content-Type':'application/json','Cache-Control':'max-age=3600'}}))}catch(_){}}

async function finalizeSavedPhoto(env,code,p,fileId){
  const token=String(p.uploadToken||'');
  const prior=await readSyncState(token);
  if(prior&&prior.status==='done')return prior.result;
  await writeSyncState(token,{status:'running',startedAt:Date.now()});
  try{
    const prep=await callAppsScript(env,'prepareExternalPhotoUploadV5',[code,p],{retries:0,timeoutMs:35000});
    if(prep&&prep.alreadyCommitted){const done={...prep,ok:true,pendingMetadata:false};await writeSyncState(token,{status:'done',result:done,finishedAt:Date.now()});return done;}
    const accessToken=String(prep&&prep.accessToken||'');if(accessToken)await rememberGoogleToken(accessToken,Date.now()+45*60*1000);
    if(!prep?.folderId||!prep?.fileName)throw new Error('Store folder authorization is still pending.');
    const moved=await moveDriveFile(env,fileId,String(prep.folderId),String(prep.fileName));
    const commitPayload={...p,type:prep.type,folderId:prep.folderId,fileName:prep.fileName,fileId:moved.id};
    const result=await confirmPhotoMetadata(env,code,commitPayload);
    const done={...result,ok:true,pendingMetadata:false,fileId:moved.id,url:moved.webViewLink||result?.url||'',name:moved.name||prep.fileName,folderId:prep.folderId};
    await writeSyncState(token,{status:'done',result:done,finishedAt:Date.now()});
    return done;
  }catch(err){await writeSyncState(token,{status:'error',message:String(err&&err.message||err),finishedAt:Date.now()});throw err;}
}

async function handlePhotoPreflight(request,env){const body=await request.json(),code=String(body.accessCode||'').trim();const p={storeKey:String(body.storeKey||''),photoType:String(body.photoType||''),addAnother:!!body.addAnother,uploadToken:String(body.uploadToken||''),originalName:String(body.originalName||''),mime:String(body.mime||'application/octet-stream'),size:Number(body.size||0)};if(!code||!p.storeKey||!p.photoType||!p.uploadToken)throw new Error('Photo upload information is incomplete.');if(p.size<=0||p.size>12*1024*1024)throw new Error('Photo size is not supported.');if(p.mime&&p.mime!=='application/octet-stream'&&!p.mime.startsWith('image/'))throw new Error('The selected file is not a supported image.');const driveToken=await getGoogleAccessToken(env,false),shell=await createPendingFile(env,p),sealedToken=await sealText(env,driveToken),payload={...p,accessCode:code,fileId:String(shell.id||''),tempName:String(shell.name||''),sealedDriveToken:sealedToken,expiresAt:Date.now()+10*60*1000};return {ok:true,preflight:await signPreflight(env,payload),fileReserved:true,driveFirst:true};}

async function handlePhotoConfirm(request,env){
  const resume=await verifyResume(env,await request.json()),code=String(resume.accessCode||'').trim(),cp=resume.commitPayload||{},p=cp.photo||cp;
  const token=String(p.uploadToken||''),state=await readSyncState(token);
  if(state&&state.status==='done')return {...state.result,ok:true,pendingMetadata:false};
  const fileId=String(cp.fileId||p.fileId||'');if(!fileId)throw new Error('Saved Drive photo reference is missing.');
  return await finalizeSavedPhoto(env,code,p,fileId);
}

async function handlePhoto(request,env,ctx){const form=await request.formData(),file=form.get('photoFile');if(!(file instanceof File))throw new Error('No photo was received.');if(file.size<=0)throw new Error('The selected photo is empty.');if(file.size>12*1024*1024)throw new Error('This photo is over 12 MB. Please retake it using the normal phone camera.');const code=String(form.get('accessCode')||'').trim(),p={storeKey:String(form.get('storeKey')||''),photoType:String(form.get('photoType')||''),addAnother:String(form.get('addAnother')||'')==='1',uploadToken:String(form.get('uploadToken')||''),originalName:String(file.name||''),mime:String(file.type||'application/octet-stream'),size:Number(file.size||0)};const rawTicket=String(form.get('preflight')||'').trim();if(!rawTicket)throw new Error('Secure photo slot is missing. Please choose the photo again.');let ticket;try{ticket=JSON.parse(rawTicket)}catch(_){throw new Error('Photo upload preflight is unreadable.')}const signed=await verifyPreflight(env,ticket);if(String(signed.accessCode||'')!==code||String(signed.storeKey||'')!==p.storeKey||String(signed.photoType||'')!==p.photoType||String(signed.uploadToken||'')!==p.uploadToken||!!signed.addAnother!==!!p.addAnother||Number(signed.size||0)!==Number(file.size||0))throw new Error('Photo upload preflight does not match this photo.');const driveToken=await openText(env,signed.sealedDriveToken);if(!driveToken)throw new Error('Photo upload credential could not be restored.');await rememberGoogleToken(driveToken,Date.now()+30*60*1000);const fileId=String(signed.fileId||'');if(!fileId)throw new Error('Google Drive photo slot is missing.');let drive=await getDriveFile(env,fileId);if(Number(drive.size||0)!==Number(file.size||0)||Number(drive.size||0)===0)drive=await uploadDriveMedia(env,fileId,file,p.mime);if(Number(drive.size||file.size||0)<=0)throw new Error('Google Drive did not confirm the photo bytes.');const resume=await signResume(env,code,{stage:'organize',fileId:drive.id,photo:p});return {ok:true,pendingMetadata:true,driveVerified:true,fileId:drive.id,url:drive.webViewLink||'',name:drive.name||signed.tempName||'Saved photo',folderId:'',type:p.photoType,baseType:p.photoType,isExtra:!!p.addAnother,bytes:Number(drive.size||file.size||0),message:'Photo is safely saved in Drive. Store-folder placement and POE sync are finishing automatically.',resume};}

async function handleHealth(request,env,ctx){if(ctx&&ctx.waitUntil)ctx.waitUntil(warmGoogleAccessToken(env));return jsonResponse(request,env,{ok:true,workerVersion:'5.0.1',workerBuild:'5.0.11-deterministic-poe-reconcile',bridge:{ok:true,bridge:'SMF_API_V5',version:'5.0.1',mode:'LIVE'}});}

export default {async fetch(request,env,ctx){if(request.method==='OPTIONS')return new Response(null,{status:204,headers:corsHeaders(request,env)});try{assertOrigin(request,env);const url=new URL(request.url);if(url.pathname==='/api/health'&&request.method==='GET')return await handleHealth(request,env,ctx);if(request.method!=='POST')return jsonResponse(request,env,{ok:false,error:'Method not allowed.'},405);if(url.pathname==='/api/action')return jsonResponse(request,env,{ok:true,result:await handleAction(request,env,ctx)});if(url.pathname==='/api/photo/preflight')return jsonResponse(request,env,{ok:true,result:await handlePhotoPreflight(request,env)});if(url.pathname==='/api/photo')return jsonResponse(request,env,{ok:true,result:await handlePhoto(request,env,ctx)});if(url.pathname==='/api/photo/confirm')return jsonResponse(request,env,{ok:true,result:await handlePhotoConfirm(request,env)});return jsonResponse(request,env,{ok:false,error:'Not found.'},404);}catch(err){return jsonResponse(request,env,{ok:false,error:String(err&&err.message?err.message:err)},400);}}};