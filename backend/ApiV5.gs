/*
SMF v5 API Bridge
ADD THIS AS A SEPARATE ApiV5.gs FILE TO THE EXISTING v4.8.2 APPS SCRIPT PROJECT.
DO NOT REPLACE Code.gs. This bridge deliberately reuses the existing v4.8.2
business logic, Store IDs, Store Keys, Sheets and Drive hierarchy.

Required Script Property:
  API_BRIDGE_SECRET = a long random secret shared only with the API Worker.
*/

function apiV5Json_(obj){return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);}
function apiV5Secret_(){return String(PropertiesService.getScriptProperties().getProperty('API_BRIDGE_SECRET')||'');}
function apiV5RequireBridgeSecret_(received){const expected=apiV5Secret_();if(!expected)throw new Error('API_BRIDGE_SECRET is not configured in Script Properties.');if(String(received||'')!==expected)throw new Error('API bridge authorization failed.');}
function apiV5Actions_(){return {
  'loginV4':loginV4,
  'getFieldHomeV4':getFieldHomeV4,'getStoreV4':getStoreV4,'saveStoreV4':saveStoreV4,
  'submitStoreVisitV4':submitStoreVisitV4,'submitDayV4':submitDayV4,'removePhotoV4':removePhotoV4,'rescheduleStoreV4':rescheduleStoreV4,
  'getClientDashboardV4':getClientDashboardV4,'getClientStoreV4':getClientStoreV4,
  'getAdminDashboardV4':getAdminDashboardV4,'getAdminIssuesV4':getAdminIssuesV4,'getPoeIndexV4':getPoeIndexV4,
  'getAdminStoreV4':getAdminStoreV4,'reopenStoreVisitV4':reopenStoreVisitV4,
  'getUsersV4':getUsersV4,'createUserV4':createUserV4,'setUserActiveV4':setUserActiveV4,'setUserTeamV4':setUserTeamV4,
  'resetUserCodeV4':resetUserCodeV4,'getRulesV4':getRulesV4,'setStoreGuideV4':setStoreGuideV4,'setCategoryGuideV4':setCategoryGuideV4,
  'getSystemV4':getSystemV4,'photoUploadHealthV4':photoUploadHealthV4,'healthV4':healthV4,'createOrResetClientAccessV4':createOrResetClientAccessV4
};}
function doPost(e){
  try{
    const body=JSON.parse(String(e&&e.postData&&e.postData.contents||'{}'));apiV5RequireBridgeSecret_(body.bridgeSecret);
    const action=String(body.action||''),args=Array.isArray(body.args)?body.args:[];
    if(action==='prepareExternalPhotoUploadV5')return apiV5Json_({ok:true,result:prepareExternalPhotoUploadV5.apply(null,args)});
    if(action==='prepareExternalPhotoV5')return apiV5Json_({ok:true,result:prepareExternalPhotoV5.apply(null,args)});
    if(action==='commitExternalPhotoV5')return apiV5Json_({ok:true,result:commitExternalPhotoV5.apply(null,args)});
    if(action==='commitExternalPhotoFastV5')return apiV5Json_({ok:true,result:commitExternalPhotoFastV5.apply(null,args)});
    if(action==='finalizeSavedPhotoV5')return apiV5Json_({ok:true,result:finalizeSavedPhotoV5.apply(null,args)});
    if(action==='getDriveUploadTokenV5')return apiV5Json_({ok:true,result:getDriveUploadTokenV5()});
    if(action==='getBridgeHealthV5')return apiV5Json_({ok:true,result:getBridgeHealthV5()});
    const fn=apiV5Actions_()[action];if(typeof fn!=='function')throw new Error('API action is not allowed.');
    return apiV5Json_({ok:true,result:fn.apply(null,args)});
  }catch(err){return apiV5Json_({ok:false,error:String(err&&err.message?err.message:err)});}
}
function getBridgeHealthV5(){return {ok:true,bridge:'SMF_API_V5',version:'5.0.1',build:'5.0.9-single-finalize',mode:mode_(),timestamp:now_(),stores:storeRows_().length,photosSheet:!!ss_().getSheetByName(V4.PHOTOS)};}
function getDriveUploadTokenV5(){return {accessToken:ScriptApp.getOAuthToken(),issuedAt:now_()};}
function externalPhotoExtV5_(name,mime){name=String(name||'');mime=String(mime||'').toLowerCase();const m=name.match(/\.([A-Za-z0-9]{2,5})$/);if(m)return m[1].toLowerCase();if(mime.indexOf('png')>=0)return 'png';if(mime.indexOf('webp')>=0)return 'webp';if(mime.indexOf('heic')>=0)return 'heic';if(mime.indexOf('heif')>=0)return 'heif';return 'jpg';}
function externalPhotoFolderV5_(s){let storeFolder=existingStorePhotoFolder_(s.key);if(storeFolder)return storeFolder;const root=DriveApp.getFolderById(cfg_('POE_ROOT_FOLDER_ID')||V4.ROOT_FOLDER_ID),envFolder=folder_(root,mode_()),teamFolder=folder_(envFolder,s.team),areaFolder=folder_(teamFolder,safe_(s.area));return folder_(areaFolder,s.storeId?s.storeId+' - '+safe_(s.name):safe_(s.name));}

function apiV5PhotoSheet_(){const sh=ss_().getSheetByName(V4.PHOTOS);if(!sh)throw new Error('V4_PHOTOS sheet is missing.');const lastCol=sh.getLastColumn();if(lastCol<1)throw new Error('V4_PHOTOS has no headers.');const headers=sh.getRange(1,1,1,lastCol).getValues()[0].map(String),map={};headers.forEach((h,i)=>map[h]=i+1);['Environment','Store Key','Photo Type','File ID','File Name','File URL','Folder ID','Active','Uploaded At','Uploaded By','Guide Used','Notes'].forEach(h=>{if(!map[h])throw new Error('V4_PHOTOS is missing column: '+h);});return {sh:sh,headers:headers,map:map,lastCol:lastCol,lastRow:sh.getLastRow()};}
function apiV5RowObject_(info,row){const vals=info.sh.getRange(row,1,1,info.lastCol).getValues()[0],o={_row:row};info.headers.forEach((h,i)=>o[h]=vals[i]);return o;}
function apiV5FindPhotoByTokenFast_(storeKey,note,info){info=info||apiV5PhotoSheet_();if(info.lastRow<2)return null;const hits=info.sh.getRange(2,info.map.Notes,info.lastRow-1,1).createTextFinder(String(note||'')).matchEntireCell(true).findAll();for(let i=hits.length-1;i>=0;i--){const row=hits[i].getRow(),env=String(info.sh.getRange(row,info.map.Environment).getValue()||'').toUpperCase(),sk=String(info.sh.getRange(row,info.map['Store Key']).getValue()||''),active=info.sh.getRange(row,info.map.Active).getValue();if(env===mode_()&&sk===String(storeKey||'')&&truth_(active))return apiV5RowObject_(info,row);}return null;}
function apiV5FindFolderIdFast_(storeKey,info){info=info||apiV5PhotoSheet_();if(info.lastRow<2)return '';const hits=info.sh.getRange(2,info.map['Store Key'],info.lastRow-1,1).createTextFinder(String(storeKey||'')).matchEntireCell(true).findAll();for(let i=hits.length-1;i>=0;i--){const row=hits[i].getRow(),env=String(info.sh.getRange(row,info.map.Environment).getValue()||'').toUpperCase(),folderId=String(info.sh.getRange(row,info.map['Folder ID']).getValue()||'').trim();if(env===mode_()&&folderId)return folderId;}return '';}
function apiV5StoreFolderFast_(s,info){const cache=CacheService.getScriptCache(),key='v5folder_'+mode_()+'_'+String(s.key||'').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,120);let id=String(cache.get(key)||'');if(id){try{return DriveApp.getFolderById(id)}catch(_){}}
  id=apiV5FindFolderIdFast_(s.key,info);if(id){try{const f=DriveApp.getFolderById(id);cache.put(key,id,21600);return f}catch(_){}}
  const f=externalPhotoFolderV5_(s);cache.put(key,f.getId(),21600);return f;}
function apiV5DeactivateOldMainFast_(s,baseType,newFileId,u,info){info=info||apiV5PhotoSheet_();if(info.lastRow<2)return true;const hits=info.sh.getRange(2,info.map['Store Key'],info.lastRow-1,1).createTextFinder(String(s.key)).matchEntireCell(true).findAll();hits.forEach(hit=>{const row=hit.getRow();const env=String(info.sh.getRange(row,info.map.Environment).getValue()||'').toUpperCase(),type=String(info.sh.getRange(row,info.map['Photo Type']).getValue()||''),active=info.sh.getRange(row,info.map.Active).getValue(),fid=String(info.sh.getRange(row,info.map['File ID']).getValue()||'');if(env===mode_()&&type===baseType&&truth_(active)&&fid!==String(newFileId||'')){info.sh.getRange(row,info.map.Active).setValue(false);info.sh.getRange(row,info.map.Notes).setValue('Replaced by '+u.name+' at '+now_());}});return true;}
function externalPhotoDeactivateOldMainV5_(s,baseType,newFileId,u){return apiV5DeactivateOldMainFast_(s,baseType,newFileId,u,apiV5PhotoSheet_());}

function prepareExternalPhotoUploadV5(code,p){
  const u=auth_(code,['FIELD']);p=payload_(p);const s=store_(p.storeKey);if(s.team!==u.team)throw new Error('Store is not assigned to your team.');
  const baseType=String(p.photoType||'').toUpperCase().trim();if(!baseType)throw new Error('Photo type is missing.');
  const isExtra=truth_(p.addAnother),uploadToken=String(p.uploadToken||'').trim();if(!uploadToken)throw new Error('Upload session is missing. Refresh or reopen the app and try again.');
  const size=Number(p.size||0);if(size<=0)throw new Error('The selected photo is empty.');if(size>12*1024*1024)throw new Error('This photo is unusually large (over 12 MB). Please retake it using the normal phone camera.');
  const mime=String(p.mime||'').toLowerCase();if(mime&&mime.indexOf('image/')!==0&&mime!=='application/octet-stream')throw new Error('The selected file is not a supported image.');
  const info=apiV5PhotoSheet_(),folder=apiV5StoreFolderFast_(s,info),suffix=uploadTokenSuffix_(uploadToken),type=isExtra?'EXTRA__'+baseType+'__'+suffix.slice(0,8):baseType,ext=externalPhotoExtV5_(p.originalName,mime),fileName=safe_(s.name)+'_'+type+'_'+suffix+'.'+ext;
  return {ok:true,storeKey:s.key,storeName:s.name,team:s.team,guide:s.guide,uploadedBy:u.name,baseType:baseType,type:type,isExtra:isExtra,uploadToken:uploadToken,folderId:folder.getId(),fileName:fileName,fileId:'',mime:mime||'image/jpeg',size:size,maxBytes:12*1024*1024,accessToken:ScriptApp.getOAuthToken(),issuedAt:now_()};
}

function prepareExternalPhotoV5(code,p){
  const u=auth_(code,['FIELD']);p=payload_(p);const s=store_(p.storeKey);if(s.team!==u.team)throw new Error('Store is not assigned to your team.');
  const poe=poeMap_()[s.key];if(poe&&isFinalOutcome_(poe))throw new Error('This store has a final status and its POE is read-only.');
  const baseType=String(p.photoType||'').toUpperCase(),valid=photoRequirements_(s,{}).map(x=>x.type);if(valid.indexOf(baseType)<0)throw new Error('Invalid photo type.');
  const isExtra=truth_(p.addAnother),uploadToken=String(p.uploadToken||'').trim();if(!uploadToken)throw new Error('Upload session is missing. Refresh or reopen the app and try again.');
  const note=photoUploadNote_(uploadToken),info=apiV5PhotoSheet_(),existing=apiV5FindPhotoByTokenFast_(s.key,note,info);if(existing)return Object.assign(photoResultFromRow_(existing,baseType,isExtra),{alreadyCommitted:true});
  const size=Number(p.size||0);if(size<=0)throw new Error('The selected photo is empty.');if(size>12*1024*1024)throw new Error('This photo is unusually large (over 12 MB). Please retake it using the normal phone camera.');
  const mime=String(p.mime||'').toLowerCase();if(mime&&mime.indexOf('image/')!==0&&mime!=='application/octet-stream')throw new Error('The selected file is not a supported image.');
  const folder=apiV5StoreFolderFast_(s,info),suffix=uploadTokenSuffix_(uploadToken),type=isExtra?'EXTRA__'+baseType+'__'+suffix.slice(0,8):baseType,ext=externalPhotoExtV5_(p.originalName,mime),fileName=safe_(s.name)+'_'+type+'_'+suffix+'.'+ext;
  return {ok:true,alreadyCommitted:false,storeKey:s.key,storeName:s.name,team:s.team,guide:s.guide,uploadedBy:u.name,baseType:baseType,type:type,isExtra:isExtra,uploadToken:uploadToken,folderId:folder.getId(),fileName:fileName,fileId:'',mime:mime||'image/jpeg',maxBytes:12*1024*1024};
}
function apiV5AppendPhotoFast_(data,info){info=info||apiV5PhotoSheet_();const row=info.headers.map(h=>Object.prototype.hasOwnProperty.call(data,h)?data[h]:'');info.sh.appendRow(row);}

function finalizeSavedPhotoV5(code,p){
  const u=auth_(code,['FIELD']);p=payload_(p);const s=store_(p.storeKey);if(s.team!==u.team)throw new Error('Store is not assigned to your team.');
  const uploadToken=String(p.uploadToken||'').trim(),baseType=String(p.photoType||'').toUpperCase().trim(),fileId=String(p.fileId||'').trim();
  if(!uploadToken)throw new Error('Upload session is missing.');if(!baseType||baseType.length>120)throw new Error('Photo type is invalid.');if(!fileId)throw new Error('Saved Drive photo reference is missing.');
  const isExtra=truth_(p.addAnother),note=photoUploadNote_(uploadToken),info=apiV5PhotoSheet_();let existing=apiV5FindPhotoByTokenFast_(s.key,note,info);if(existing)return photoResultFromRow_(existing,baseType,isExtra);
  const f=DriveApp.getFileById(fileId);if(Number(f.getSize()||0)<=0)throw new Error('Saved Drive photo is empty.');
  const folder=apiV5StoreFolderFast_(s,info),folderId=folder.getId(),suffix=uploadTokenSuffix_(uploadToken),type=isExtra?'EXTRA__'+baseType+'__'+suffix.slice(0,8):baseType,ext=externalPhotoExtV5_(p.originalName,String(p.mime||f.getMimeType()||'')),fileName=safe_(s.name)+'_'+type+'_'+suffix+'.'+ext;
  const lock=LockService.getScriptLock();if(!lock.tryLock(5000))throw new Error('Photo is safe in Drive; POE sync is busy and will retry.');
  try{
    existing=apiV5FindPhotoByTokenFast_(s.key,note,info);if(existing)return photoResultFromRow_(existing,baseType,isExtra);
    if(f.getName()!==fileName)f.setName(fileName);
    let correctParent=false;const parents=f.getParents();while(parents.hasNext()){if(parents.next().getId()===folderId){correctParent=true;break;}}
    if(!correctParent)f.moveTo(folder);
    apiV5AppendPhotoFast_({Environment:mode_(),'Store Key':s.key,'Store Name':s.name,Team:s.team,'Photo Type':type,'File ID':f.getId(),'File Name':f.getName(),'File URL':f.getUrl(),'Folder ID':folderId,Active:true,'Uploaded At':new Date(),'Uploaded By':u.name,'Guide Used':s.guide,Notes:note},info);
    if(!isExtra)apiV5DeactivateOldMainFast_(s,baseType,f.getId(),u,info);
    return {ok:true,type:type,baseType:baseType,isExtra:isExtra,fileId:f.getId(),url:f.getUrl(),previewUrl:'https://drive.google.com/thumbnail?id='+encodeURIComponent(f.getId())+'&sz=w1600',name:f.getName(),folderId:folderId,folderUrl:driveFolderUrl_(folderId),uploadedAt:now_(),duplicateRequest:false,transport:'V5_SINGLE_FINALIZE',bytes:Number(f.getSize()||0),mime:String(f.getMimeType()||p.mime||'')};
  }finally{try{lock.releaseLock()}catch(_){}}
}

function commitExternalPhotoFastV5(code,p){
  const u=auth_(code,['FIELD']);p=payload_(p);const s=store_(p.storeKey);if(s.team!==u.team)throw new Error('Store is not assigned to your team.');
  const poe=poeMap_()[s.key];if(poe&&isFinalOutcome_(poe))throw new Error('This store has a final status and its POE is read-only.');
  const uploadToken=String(p.uploadToken||'').trim();if(!uploadToken)throw new Error('Upload session is missing.');
  const baseType=String(p.photoType||'').toUpperCase(),valid=photoRequirements_(s,{}).map(x=>x.type);if(valid.indexOf(baseType)<0)throw new Error('Invalid photo type.');
  const isExtra=truth_(p.addAnother),note=photoUploadNote_(uploadToken),info=apiV5PhotoSheet_();
  let existing=apiV5FindPhotoByTokenFast_(s.key,note,info);if(existing)return photoResultFromRow_(existing,baseType,isExtra);
  const fileId=String(p.fileId||'').trim(),fileName=String(p.fileName||'').trim(),folderId=String(p.folderId||'').trim();if(!fileId||!fileName||!folderId)throw new Error('Photo confirmation is incomplete.');
  const f=DriveApp.getFileById(fileId);if(f.getName()!==fileName)throw new Error('Uploaded photo name does not match the reserved upload.');if(Number(f.getSize()||0)<=0)throw new Error('Uploaded photo is empty.');
  let correctParent=false;const parents=f.getParents();while(parents.hasNext()){if(parents.next().getId()===folderId){correctParent=true;break;}}if(!correctParent)throw new Error('Uploaded photo is not in the authorized store folder.');
  const lock=LockService.getScriptLock();if(!lock.tryLock(1200))throw new Error('Photo is saved in Drive; metadata sync is busy.');
  try{
    existing=apiV5FindPhotoByTokenFast_(s.key,note,info);if(existing)return photoResultFromRow_(existing,baseType,isExtra);
    apiV5AppendPhotoFast_({Environment:mode_(),'Store Key':s.key,'Store Name':s.name,Team:s.team,'Photo Type':String(p.type||baseType),'File ID':f.getId(),'File Name':f.getName(),'File URL':f.getUrl(),'Folder ID':folderId,Active:true,'Uploaded At':new Date(),'Uploaded By':u.name,'Guide Used':s.guide,Notes:note},info);
    if(!isExtra)apiV5DeactivateOldMainFast_(s,baseType,f.getId(),u,apiV5PhotoSheet_());
    return {ok:true,type:String(p.type||baseType),baseType:baseType,isExtra:isExtra,fileId:f.getId(),url:f.getUrl(),previewUrl:'https://drive.google.com/thumbnail?id='+encodeURIComponent(f.getId())+'&sz=w1600',name:f.getName(),folderId:folderId,folderUrl:driveFolderUrl_(folderId),uploadedAt:now_(),duplicateRequest:false,transport:'V5_FAST_COMMIT',bytes:Number(f.getSize()||0),mime:String(f.getMimeType()||p.mime||'')};
  }finally{try{lock.releaseLock()}catch(_){}}
}
function commitExternalPhotoV5(code,p){p=payload_(p);return commitExternalPhotoFastV5(code,p);}
