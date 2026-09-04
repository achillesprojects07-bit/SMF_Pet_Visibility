/*
SMF v5 API Bridge
ADD THIS AS A SEPARATE ApiV5.gs FILE TO THE EXISTING v4.8.2 APPS SCRIPT PROJECT.
DO NOT REPLACE Code.gs. This bridge deliberately reuses the existing v4.8.2
business logic, Store IDs, Store Keys, Sheets and Drive hierarchy.

Required Script Property:
  API_BRIDGE_SECRET = a long random secret shared only with the API Worker.
*/

function apiV5Json_(obj){
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
function apiV5Secret_(){return String(PropertiesService.getScriptProperties().getProperty('API_BRIDGE_SECRET')||'');}
function apiV5RequireBridgeSecret_(received){
  const expected=apiV5Secret_();
  if(!expected)throw new Error('API_BRIDGE_SECRET is not configured in Script Properties.');
  if(String(received||'')!==expected)throw new Error('API bridge authorization failed.');
}
function apiV5Actions_(){
  return {
    'loginV4':loginV4,
    'getFieldHomeV4':getFieldHomeV4,'getStoreV4':getStoreV4,'saveStoreV4':saveStoreV4,
    'submitStoreVisitV4':submitStoreVisitV4,'submitDayV4':submitDayV4,'removePhotoV4':removePhotoV4,'rescheduleStoreV4':rescheduleStoreV4,
    'getClientDashboardV4':getClientDashboardV4,'getClientStoreV4':getClientStoreV4,
    'getAdminDashboardV4':getAdminDashboardV4,'getAdminIssuesV4':getAdminIssuesV4,'getPoeIndexV4':getPoeIndexV4,
    'getAdminStoreV4':getAdminStoreV4,'reopenStoreVisitV4':reopenStoreVisitV4,
    'getUsersV4':getUsersV4,'createUserV4':createUserV4,'setUserActiveV4':setUserActiveV4,'setUserTeamV4':setUserTeamV4,
    'resetUserCodeV4':resetUserCodeV4,'getRulesV4':getRulesV4,'setStoreGuideV4':setStoreGuideV4,'setCategoryGuideV4':setCategoryGuideV4,
    'getSystemV4':getSystemV4,'photoUploadHealthV4':photoUploadHealthV4,'healthV4':healthV4,'createOrResetClientAccessV4':createOrResetClientAccessV4
  };
}
function doPost(e){
  try{
    const body=JSON.parse(String(e&&e.postData&&e.postData.contents||'{}'));
    apiV5RequireBridgeSecret_(body.bridgeSecret);
    const action=String(body.action||'');
    const args=Array.isArray(body.args)?body.args:[];
    if(action==='prepareExternalPhotoV5')return apiV5Json_({ok:true,result:prepareExternalPhotoV5.apply(null,args)});
    if(action==='commitExternalPhotoV5')return apiV5Json_({ok:true,result:commitExternalPhotoV5.apply(null,args)});
    if(action==='commitExternalPhotoFastV5')return apiV5Json_({ok:true,result:commitExternalPhotoFastV5.apply(null,args)});
    if(action==='getDriveUploadTokenV5')return apiV5Json_({ok:true,result:getDriveUploadTokenV5()});
    if(action==='getBridgeHealthV5')return apiV5Json_({ok:true,result:getBridgeHealthV5()});
    const fn=apiV5Actions_()[action];
    if(typeof fn!=='function')throw new Error('API action is not allowed.');
    return apiV5Json_({ok:true,result:fn.apply(null,args)});
  }catch(err){return apiV5Json_({ok:false,error:String(err&&err.message?err.message:err)});}
}
function getBridgeHealthV5(){
  return {ok:true,bridge:'SMF_API_V5',version:'5.0.1',mode:mode_(),timestamp:now_(),stores:storeRows_().length,photosSheet:!!ss_().getSheetByName(V4.PHOTOS)};
}
function getDriveUploadTokenV5(){return {accessToken:ScriptApp.getOAuthToken(),issuedAt:now_()};}
function externalPhotoExtV5_(name,mime){
  name=String(name||'');mime=String(mime||'').toLowerCase();
  const m=name.match(/\.([A-Za-z0-9]{2,5})$/);if(m)return m[1].toLowerCase();
  if(mime.indexOf('png')>=0)return 'png';if(mime.indexOf('webp')>=0)return 'webp';if(mime.indexOf('heic')>=0)return 'heic';if(mime.indexOf('heif')>=0)return 'heif';return 'jpg';
}
function externalPhotoExistingByTokenV5_(storeKey,note){
  return rows_(V4.PHOTOS).find(x=>String(x.Environment||'').toUpperCase()===mode_()&&String(x['Store Key']||'')===String(storeKey||'')&&String(x.Notes||'')===String(note||'')&&truth_(x.Active))||null;
}
function externalPhotoFolderV5_(s){
  let storeFolder=existingStorePhotoFolder_(s.key);if(storeFolder)return storeFolder;
  const root=DriveApp.getFolderById(cfg_('POE_ROOT_FOLDER_ID')||V4.ROOT_FOLDER_ID),envFolder=folder_(root,mode_()),teamFolder=folder_(envFolder,s.team),areaFolder=folder_(teamFolder,safe_(s.area));
  return folder_(areaFolder,s.storeId?s.storeId+' - '+safe_(s.name):safe_(s.name));
}
function externalPhotoReserveShellV5_(folder,fileName,mime){
  const lock=LockService.getScriptLock();if(!lock.tryLock(3000))throw new Error('The upload service is busy reserving this photo. Please retry.');
  try{const matches=folder.getFilesByName(fileName);if(matches.hasNext())return matches.next();return folder.createFile(Utilities.newBlob('',mime||'application/octet-stream',fileName));}
  finally{try{lock.releaseLock()}catch(_){}}
}
function externalPhotoDeactivateOldMainV5_(s,baseType,newFileId,u){
  const matches=rows_(V4.PHOTOS).filter(x=>String(x.Environment||'').toUpperCase()===mode_()&&String(x['Store Key']||'')===s.key&&String(x['Photo Type']||'')===baseType&&truth_(x.Active)&&String(x['File ID']||'')!==String(newFileId||''));
  matches.forEach(x=>{try{update_(V4.PHOTOS,x._row,{Active:false,Notes:'Replaced by '+u.name+' at '+now_()})}catch(_){}});
  return true;
}
function prepareExternalPhotoV5(code,p){
  const u=auth_(code,['FIELD']);p=payload_(p);const s=store_(p.storeKey);if(s.team!==u.team)throw new Error('Store is not assigned to your team.');
  const poe=poeMap_()[s.key];if(poe&&isFinalOutcome_(poe))throw new Error('This store has a final status and its POE is read-only.');
  const baseType=String(p.photoType||'').toUpperCase(),valid=photoRequirements_(s,{}).map(x=>x.type);if(valid.indexOf(baseType)<0)throw new Error('Invalid photo type.');
  const isExtra=truth_(p.addAnother),uploadToken=String(p.uploadToken||'').trim();if(!uploadToken)throw new Error('Upload session is missing. Refresh or reopen the app and try again.');
  const note=photoUploadNote_(uploadToken),existing=externalPhotoExistingByTokenV5_(s.key,note);if(existing)return Object.assign(photoResultFromRow_(existing,baseType,isExtra),{alreadyCommitted:true});
  const size=Number(p.size||0);if(size<=0)throw new Error('The selected photo is empty.');if(size>12*1024*1024)throw new Error('This photo is unusually large (over 12 MB). Please retake it using the normal phone camera.');
  const mime=String(p.mime||'').toLowerCase();if(mime&&mime.indexOf('image/')!==0&&mime!=='application/octet-stream')throw new Error('The selected file is not a supported image.');
  const folder=externalPhotoFolderV5_(s),suffix=uploadTokenSuffix_(uploadToken),type=isExtra?'EXTRA__'+baseType+'__'+suffix.slice(0,8):baseType,ext=externalPhotoExtV5_(p.originalName,mime),fileName=safe_(s.name)+'_'+type+'_'+suffix+'.'+ext,shell=externalPhotoReserveShellV5_(folder,fileName,mime||'image/jpeg');
  return {ok:true,alreadyCommitted:false,storeKey:s.key,storeName:s.name,team:s.team,guide:s.guide,uploadedBy:u.name,baseType:baseType,type:type,isExtra:isExtra,uploadToken:uploadToken,folderId:folder.getId(),fileName:fileName,fileId:shell.getId(),mime:mime||'image/jpeg',maxBytes:12*1024*1024};
}
function apiV5AppendPhotoFast_(data){
  const sh=ss_().getSheetByName(V4.PHOTOS);if(!sh)throw new Error('V4_PHOTOS sheet is missing.');
  const lastCol=sh.getLastColumn(),headers=sh.getRange(1,1,1,lastCol).getValues()[0],row=headers.map(h=>Object.prototype.hasOwnProperty.call(data,h)?data[h]:'');
  sh.appendRow(row);SpreadsheetApp.flush();
}
function commitExternalPhotoFastV5(code,p){
  const u=auth_(code,['FIELD']);p=payload_(p);const s=store_(p.storeKey);if(s.team!==u.team)throw new Error('Store is not assigned to your team.');
  const uploadToken=String(p.uploadToken||'').trim();if(!uploadToken)throw new Error('Upload session is missing.');
  const baseType=String(p.photoType||'').toUpperCase(),isExtra=truth_(p.addAnother),note=photoUploadNote_(uploadToken);
  let existing=externalPhotoExistingByTokenV5_(s.key,note);if(existing)return photoResultFromRow_(existing,baseType,isExtra);
  const fileId=String(p.fileId||'').trim(),fileName=String(p.fileName||'').trim(),folderId=String(p.folderId||'').trim();if(!fileId||!fileName||!folderId)throw new Error('Photo confirmation is incomplete.');
  const f=DriveApp.getFileById(fileId);if(f.getName()!==fileName)throw new Error('Uploaded photo name does not match the reserved upload.');if(Number(f.getSize()||0)<=0)throw new Error('Uploaded photo is empty.');
  const lock=LockService.getScriptLock();if(!lock.tryLock(2000))throw new Error('Photo is saved in Drive; metadata sync is busy.');
  try{
    existing=externalPhotoExistingByTokenV5_(s.key,note);if(existing)return photoResultFromRow_(existing,baseType,isExtra);
    apiV5AppendPhotoFast_({Environment:mode_(),'Store Key':s.key,'Store Name':s.name,Team:s.team,'Photo Type':String(p.type||baseType),'File ID':f.getId(),'File Name':f.getName(),'File URL':f.getUrl(),'Folder ID':folderId,Active:true,'Uploaded At':new Date(),'Uploaded By':u.name,'Guide Used':s.guide,Notes:note});
    if(!isExtra)externalPhotoDeactivateOldMainV5_(s,baseType,f.getId(),u);
    return {ok:true,type:String(p.type||baseType),baseType:baseType,isExtra:isExtra,fileId:f.getId(),url:f.getUrl(),previewUrl:'https://drive.google.com/thumbnail?id='+encodeURIComponent(f.getId())+'&sz=w1600',name:f.getName(),folderId:folderId,folderUrl:driveFolderUrl_(folderId),uploadedAt:now_(),duplicateRequest:false,transport:'V5_FAST_COMMIT',bytes:Number(f.getSize()||0),mime:String(f.getMimeType()||p.mime||'')};
  }finally{try{lock.releaseLock()}catch(_){}}
}
function commitExternalPhotoV5(code,p){
  p=payload_(p);
  return commitExternalPhotoFastV5(code,p);
}
