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
  'getBridgeHealthV5','getDriveUploadTokenV5','prepareExternalPhotoV5','commitExternalPhotoFastV5',
  'loginV4','getFieldHomeV4','getStoreV4','getClientDashboardV4','getClientStoreV4',
  'getAdminDashboardV4','getAdminIssuesV4','getPoeIndexV4','getAdminStoreV4','getUsersV4','getRulesV4','getSystemV4','photoUploadHealthV4','healthV4'
]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const te = new TextEncoder();

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
  catch(err){if(err&&err.name==='AbortError')throw new Error('Apps Script bridge timed out while finalizing the request.');throw new Error('Apps Script bridge connection failed.');}
  finally{clearTimeout(timer);}
  const text=await r.text();let data;
  try{data=JSON.parse(text);}catch(_){const type=String(r.headers.get('content-type')||'').toLowerCase();if(!r.ok)throw new Error('Apps Script bridge returned HTTP '+r.status+'.');if(type.includes('text/html'))throw new Error('Apps Script bridge returned HTML instead of JSON.');throw new Error('Apps Script bridge returned an unreadable response.');}
  if(!r.ok||!data||data.ok===false)throw new Error((data&&data.error)||('Apps Script bridge failed (HTTP '+r.status+').'));return data.result;
}
async function callAppsScript(env,action,args,options={}){const safe=SAFE_BRIDGE_RETRY.has(action),retries=Number.isInteger(options.retries)?options.retries:(safe?1:0),timeoutMs=Number(options.timeoutMs||8000);let lastErr;for(let attempt=0;attempt<=retries;attempt++){try{return await bridgeFetchOnce(env,action,args,timeoutMs)}catch(err){lastErr=err;if(attempt>=retries)break;await sleep(400*(attempt+1))}}throw lastErr||new Error('Apps Script bridge failed.');}
async function getGoogleAccessToken(env,forceFresh=false){const now=Date.now();if(!forceFresh&&cachedGoogleToken&&cachedGoogleToken.expiresAt>now+60000)return cachedGoogleToken.token;const r=await callAppsScript(env,'getDriveUploadTokenV5',[],{retries:1,timeoutMs:8000}),token=String(r&&r.accessToken||'');if(!token)throw new Error('Apps Script did not provide a Google Drive upload token.');cachedGoogleToken={token,expiresAt:now+35*60*1000};return token;}
async function driveFetch(env,url,init={},retry401=true){let token=await getGoogleAccessToken(env,false);let r=await fetch(url,{...init,headers:{...(init.headers||{}),Authorization:`Bearer ${token}`}});if(r.status===401&&retry401){token=await getGoogleAccessToken(env,true);r=await fetch(url,{...init,headers:{...(init.headers||{}),Authorization:`Bearer ${token}`}})}return r;}
async function getDriveFile(env,fileId){const r=await driveFetch(env,`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,parents`),data=await r.json();if(!r.ok||!data.id)throw new Error('Could not verify the reserved Google Drive photo file.');return data;}
async function uploadDriveMedia(env,fileId,file,mime){const r=await driveFetch(env,`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,parents`,{method:'PATCH',headers:{'Content-Type':mime||file.type||'application/octet-stream'},body:file.stream()}),data=await r.json();if(!r.ok||!data.id)throw new Error('Google Drive did not finish saving the photo.');return data;}
async function ensureDrivePhoto(env,prep,file){const fileId=String(prep&&prep.fileId||'');if(!fileId)throw new Error('Apps Script did not reserve a Drive file for this upload.');let existing=await getDriveFile(env,fileId);const currentSize=Number(existing.size||0);if(currentSize!==Number(file.size||0)||currentSize===0)existing=await uploadDriveMedia(env,fileId,file,prep.mime||file.type);if(Number(existing.size||file.size||0)<=0)throw new Error('Google Drive did not confirm the photo bytes.');return existing;}
async function handleAction(request,env){const body=await request.json(),action=String(body.action||'');if(!ACTION_ALLOWLIST.has(action))throw new Error('API action is not allowed.');return await callAppsScript(env,action,Array.isArray(body.args)?body.args:[]);}
async function confirmPhotoMetadata(env,code,p){return await callAppsScript(env,'commitExternalPhotoFastV5',[code,p],{retries:1,timeoutMs:6000});}

async function resumeKey(env){return await crypto.subtle.importKey('raw',te.encode(String(env.BRIDGE_SECRET||'')),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
function resumeBody(code,commitPayload){return JSON.stringify({accessCode:String(code||''),commitPayload:commitPayload||{}});}
function b64url(bytes){let s='';for(const b of new Uint8Array(bytes))s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function unb64url(s){s=String(s||'').replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';const raw=atob(s),a=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)a[i]=raw.charCodeAt(i);return a;}
async function signResume(env,code,commitPayload){const key=await resumeKey(env),body=resumeBody(code,commitPayload),sig=await crypto.subtle.sign('HMAC',key,te.encode(body));return {accessCode:code,commitPayload,signature:b64url(sig)};}
async function verifyResume(env,resume){if(!resume||!resume.signature)throw new Error('Photo sync authorization is missing.');const key=await resumeKey(env),body=resumeBody(resume.accessCode,resume.commitPayload),ok=await crypto.subtle.verify('HMAC',key,unb64url(resume.signature),te.encode(body));if(!ok)throw new Error('Photo sync authorization failed.');return resume;}

async function handlePhotoConfirm(request,env){const resume=await verifyResume(env,await request.json());const code=String(resume.accessCode||'').trim(),p=resume.commitPayload||{};const result=await confirmPhotoMetadata(env,code,p);return {...result,ok:true,pendingMetadata:false};}
async function handlePhoto(request,env,ctx){
  const form=await request.formData(),file=form.get('photoFile');if(!(file instanceof File))throw new Error('No photo was received.');if(file.size<=0)throw new Error('The selected photo is empty.');if(file.size>12*1024*1024)throw new Error('This photo is over 12 MB. Please retake it using the normal phone camera.');
  const code=String(form.get('accessCode')||'').trim();const p={storeKey:String(form.get('storeKey')||''),photoType:String(form.get('photoType')||''),addAnother:String(form.get('addAnother')||'')==='1',uploadToken:String(form.get('uploadToken')||''),originalName:String(file.name||''),mime:String(file.type||'application/octet-stream'),size:Number(file.size||0)};
  const prep=await callAppsScript(env,'prepareExternalPhotoV5',[code,p],{retries:1,timeoutMs:9000});if(prep&&prep.alreadyCommitted)return {...prep,ok:true,pendingMetadata:false,recovered:true};
  const drive=await ensureDrivePhoto(env,prep,file),commitPayload={...p,type:prep.type,folderId:prep.folderId,fileName:prep.fileName,fileId:drive.id};
  try{const committed=await confirmPhotoMetadata(env,code,commitPayload);return {...committed,ok:true,pendingMetadata:false};}
  catch(err){if(ctx&&ctx.waitUntil){ctx.waitUntil((async()=>{for(let i=0;i<3;i++){try{await confirmPhotoMetadata(env,code,commitPayload);return;}catch(_){await sleep(1500*(i+1));}}})());}
    return {ok:true,pendingMetadata:true,driveVerified:true,fileId:drive.id,url:drive.webViewLink||'',name:drive.name||prep.fileName,folderId:prep.folderId,type:prep.type,baseType:prep.baseType,isExtra:prep.isExtra,bytes:Number(drive.size||file.size||0),message:'Photo is safely saved in Drive. Final record sync is continuing.',resume:await signResume(env,code,commitPayload)};}
}
async function handleHealth(request,env){const bridge=await callAppsScript(env,'getBridgeHealthV5',[],{retries:1,timeoutMs:7000});return jsonResponse(request,env,{ok:true,workerVersion:'5.0.1',workerBuild:'5.0.4-signed-recovery',bridge});}

export default {async fetch(request,env,ctx){if(request.method==='OPTIONS')return new Response(null,{status:204,headers:corsHeaders(request,env)});try{assertOrigin(request,env);const url=new URL(request.url);if(url.pathname==='/api/health'&&request.method==='GET')return await handleHealth(request,env);if(request.method!=='POST')return jsonResponse(request,env,{ok:false,error:'Method not allowed.'},405);if(url.pathname==='/api/action')return jsonResponse(request,env,{ok:true,result:await handleAction(request,env)});if(url.pathname==='/api/photo')return jsonResponse(request,env,{ok:true,result:await handlePhoto(request,env,ctx)});if(url.pathname==='/api/photo/confirm')return jsonResponse(request,env,{ok:true,result:await handlePhotoConfirm(request,env)});return jsonResponse(request,env,{ok:false,error:'Not found.'},404);}catch(err){return jsonResponse(request,env,{ok:false,error:String(err&&err.message?err.message:err)},400);}}};
