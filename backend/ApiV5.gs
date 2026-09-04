/*
SMF v5 API Bridge
ADD THIS AS A SEPARATE ApiV5.gs FILE TO THE EXISTING v4.8.2 APPS SCRIPT PROJECT.
DO NOT REPLACE Code.gs. This bridge deliberately reuses the existing v4.8.2
business logic, Store IDs, Store Keys, Sheets and Drive hierarchy.

Required Script Property:
  API_BRIDGE_SECRET = a long random secret shared only with the API Worker.

v5.0.2 stability note:
- Keeps all existing Sheets/Drive data intact.
- Does not delete physical Drive files.
- Keeps upload-token idempotency.
- Removes repeated reservation/Drive work from photo commit to reduce finalization time.
*/

function apiV5Json_(obj){
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function apiV5Secret_(){
  return String(PropertiesService.getScriptProperties().getProperty('API_BRIDGE_SECRET')||'');
}

function apiV5RequireBridgeSecret_(received){
  const expected=apiV5Secret_();
  if(!expected)throw new Error('API_BRIDGE_SECRET is not configured in Script Properties.');
  if(String(received||'')!==expected)throw new Error('API bridge authorization failed.');
}

function apiV5Actions_(){
  return {
    'loginV4':loginV4,
    'getFieldHomeV4':getFieldHomeV4,
    'getStoreV4':getStoreV4,
    'saveStoreV4':saveStoreV4,
    'submitStoreVisitV4':submitStoreVisitV4,
    'submitDayV4':submitDayV4,
    'removePhotoV4':removePhotoV4,
    'rescheduleStoreV4':rescheduleStoreV4,
    'getClientDashboardV4':getClientDashboardV4,
    'getClientStoreV4':getClientStoreV4,
    'getAdminDashboardV4':getAdminDashboardV4,
    'getAdminIssuesV4':getAdminIssuesV4,
    'getPoeIndexV4':getPoeIndexV4,
    'getAdminStoreV4':getAdminStoreV4,
    'reopenStoreVisitV4':reopenStoreVisitV4,
    'getUsersV4':getUsersV4,
    'createUserV4':createUserV4,
    'setUserActiveV4':setUserActiveV4,
    'setUserTeamV4':setUserTeamV4,
    'resetUserCodeV4':resetUserCodeV4,
    'getRulesV4':getRulesV4,
    'setStoreGuideV4':setStoreGuideV4,
    'setCategoryGuideV4':setCategoryGuideV4,
    'getSystemV4':getSystemV4,
    'photoUploadHealthV4':photoUploadHealthV4,
    'healthV4':healthV4,
    'createOrResetClientAccessV4':createOrResetClientAccessV4
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
    if(action==='getDriveUploadTokenV5')return apiV5Json_({ok:true,result:getDriveUploadTokenV5()});
    if(action==='getBridgeHealthV5')return apiV5Json_({ok:true,result:getBridgeHealthV5()});
    const fn=apiV5Actions_()[action];
    if(typeof fn!=='function')throw new Error('API action is not allowed.');
    return apiV5Json_({ok:true,result:fn.apply(null,args)});
  }catch(err){
    return apiV5Json_({ok:false,error:String(err&&err.message?err.message:err)});
  }
}

function getBridgeHealthV5(){
  return {
    ok:true,
    bridge:'SMF_API_V5',
    version:'5.0.1',
    mode:mode_(),
    timestamp:now_(),
    stores:storeRows_().length,
    photosSheet:!!ss_().getSheetByName(V4.PHOTOS)
  };
}

function getDriveUploadTokenV5(){
  return {accessToken:ScriptApp.getOAuthToken(),issuedAt:now_()};
}

function externalPhotoExtV5_(name,mime){
  name=String(name||'');
  mime=String(mime||'').toLowerCase();
  const m=name.match(/\.([A-Za-z0-9]{2,5})$/);
  if(m)return m[1].toLowerCase();
  if(mime.indexOf('png')>=0)return 'png';
  if(mime.indexOf('webp')>=0)return 'webp';
  if(mime.indexOf('heic')>=0)return 'heic';
  if(mime.indexOf('heif')>=0)return 'heif';
  return 'jpg';
}

function externalPhotoExistingByTokenV5_(storeKey,note){
  const env=mode_();
  return rows_(V4.PHOTOS).find(x=>
    String(x.Environment||'').toUpperCase()===env &&
    String(x['Store Key']||'')===String(storeKey||'') &&
    String(x.Notes||'')===String(note||'') &&
    truth_(x.Active)
  )||null;
}

function externalPhotoFolderV5_(s){
  const existing=existingStorePhotoFolder_(s.key);
  if(existing)return existing;
  const root=DriveApp.getFolderById(cfg_('POE_ROOT_FOLDER_ID')||V4.ROOT_FOLDER_ID);
  const envFolder=folder_(root,mode_());
  const teamFolder=folder_(envFolder,s.team);
  const areaFolder=folder_(teamFolder,safe_(s.area));
  const stableFolderName=s.storeId?s.storeId+' - '+safe_(s.name):safe_(s.name);
  return folder_(areaFolder,stableFolderName);
}

function externalPhotoReserveShellV5_(folder,fileName,mime){
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(2500))throw new Error('The upload service is busy reserving this photo. Please retry.');
  try{
    const matches=folder.getFilesByName(fileName);
    if(matches.hasNext())return matches.next();
    return folder.createFile(Utilities.newBlob('',mime||'application/octet-stream',fileName));
  }finally{
    try{lock.releaseLock()}catch(_){}
  }
}

function externalPhotoTypeInfoV5_(s,p){
  const baseType=String(p.photoType||'').toUpperCase();
  const valid=photoRequirements_(s,{}).map(x=>x.type);
  if(valid.indexOf(baseType)<0)throw new Error('Invalid photo type.');
  const isExtra=truth_(p.addAnother);
  const uploadToken=String(p.uploadToken||'').trim();
  if(!uploadToken)throw new Error('Upload session is missing. Refresh or reopen the app and try again.');
  const suffix=uploadTokenSuffix_(uploadToken);
  const type=isExtra?'EXTRA__'+baseType+'__'+suffix.slice(0,8):baseType;
  const mime=String(p.mime||'').toLowerCase()||'image/jpeg';
  const ext=externalPhotoExtV5_(p.originalName,mime);
  const fileName=safe_(s.name)+'_'+type+'_'+suffix+'.'+ext;
  return {baseType,isExtra,uploadToken,suffix,type,mime,fileName,note:photoUploadNote_(uploadToken)};
}

function externalPhotoDeactivateOldMainV5_(s,baseType,newFileId,u){
  const env=mode_();
  const oldRows=rows_(V4.PHOTOS).filter(x=>
    String(x.Environment||'').toUpperCase()===env &&
    String(x['Store Key']||'')===s.key &&
    String(x['Photo Type']||'')===baseType &&
    truth_(x.Active) &&
    String(x['File ID']||'')!==String(newFileId||'')
  );
  let clean=true;
  oldRows.forEach(x=>{
    try{
      update_(V4.PHOTOS,x._row,{Active:false,Notes:'Replaced by '+u.name+' at '+now_()});
    }catch(err){
      clean=false;
      try{log_(u,'PHOTO_REPLACE_WARNING',s.key,baseType+' old row '+x._row+' cleanup failed: '+String(err&&err.message?err.message:err))}catch(_){}
    }
  });
  return clean;
}

function prepareExternalPhotoV5(code,p){
  const u=auth_(code,['FIELD']);
  p=payload_(p);
  const s=store_(p.storeKey);
  if(s.team!==u.team)throw new Error('Store is not assigned to your team.');

  const poe=poeMap_()[s.key];
  if(poe&&isFinalOutcome_(poe))throw new Error('This store has a final status and its POE is read-only.');

  const info=externalPhotoTypeInfoV5_(s,p);
  const existing=externalPhotoExistingByTokenV5_(s.key,info.note);
  if(existing)return Object.assign(photoResultFromRow_(existing,info.baseType,info.isExtra),{alreadyCommitted:true});

  const size=Number(p.size||0);
  if(size<=0)throw new Error('The selected photo is empty.');
  if(size>12*1024*1024)throw new Error('This photo is unusually large (over 12 MB). Please retake it using the normal phone camera.');
  if(info.mime&&info.mime.indexOf('image/')!==0&&info.mime!=='application/octet-stream')throw new Error('The selected file is not a supported image.');

  const folder=externalPhotoFolderV5_(s);
  const shell=externalPhotoReserveShellV5_(folder,info.fileName,info.mime);
  return {
    ok:true,alreadyCommitted:false,storeKey:s.key,storeName:s.name,
    baseType:info.baseType,type:info.type,isExtra:info.isExtra,uploadToken:info.uploadToken,
    folderId:folder.getId(),fileName:info.fileName,fileId:shell.getId(),mime:info.mime,
    maxBytes:12*1024*1024
  };
}

function commitExternalPhotoV5(code,p){
  const u=auth_(code,['FIELD']);
  p=payload_(p);
  const s=store_(p.storeKey);
  if(s.team!==u.team)throw new Error('Store is not assigned to your team.');

  const poe=poeMap_()[s.key];
  if(poe&&isFinalOutcome_(poe))throw new Error('This store has a final status and its POE is read-only.');

  const info=externalPhotoTypeInfoV5_(s,p);
  let existing=externalPhotoExistingByTokenV5_(s.key,info.note);
  if(existing){
    if(!info.isExtra)externalPhotoDeactivateOldMainV5_(s,info.baseType,String(existing['File ID']||''),u);
    return Object.assign(photoResultFromRow_(existing,info.baseType,info.isExtra),{ok:true,alreadyCommitted:true});
  }

  const fileId=String(p.fileId||'').trim();
  const folderId=String(p.folderId||'').trim();
  const fileName=String(p.fileName||'').trim();
  if(!fileId)throw new Error('Drive did not return a photo file ID.');
  if(!folderId)throw new Error('Photo folder verification failed.');
  if(fileName!==info.fileName)throw new Error('Photo filename verification failed.');

  // Verify only the authoritative store folder and the uploaded file. We intentionally do
  // not call prepareExternalPhotoV5() again here because that repeated Drive reservation work
  // was causing long finalization times after the browser had already uploaded the photo.
  const expectedFolder=externalPhotoFolderV5_(s);
  const expectedFolderId=expectedFolder.getId();
  if(folderId!==expectedFolderId)throw new Error('Photo folder verification failed.');

  const f=DriveApp.getFileById(fileId);
  const actualName=f.getName();
  if(actualName!==info.fileName)throw new Error('Uploaded photo name does not match the authorized upload.');

  let correctParent=false;
  const parents=f.getParents();
  while(parents.hasNext()){
    if(parents.next().getId()===expectedFolderId){correctParent=true;break;}
  }
  if(!correctParent)throw new Error('Uploaded photo is not in the authorized store folder.');

  const bytes=Number(f.getSize()||0);
  if(bytes<=0)throw new Error('Uploaded photo is empty.');

  const lock=LockService.getScriptLock();
  if(!lock.tryLock(2000))throw new Error('Photo reached Drive but the app is busy recording it. Please retry the same photo.');
  try{
    existing=externalPhotoExistingByTokenV5_(s.key,info.note);
    if(existing){
      if(!info.isExtra)externalPhotoDeactivateOldMainV5_(s,info.baseType,String(existing['File ID']||''),u);
      return Object.assign(photoResultFromRow_(existing,info.baseType,info.isExtra),{ok:true,alreadyCommitted:true});
    }

    const fileUrl=f.getUrl();
    append_(V4.PHOTOS,{
      Environment:mode_(),'Store Key':s.key,'Store Name':s.name,Team:s.team,
      'Photo Type':info.type,'File ID':fileId,'File Name':actualName,'File URL':fileUrl,
      'Folder ID':expectedFolderId,Active:true,'Uploaded At':new Date(),
      'Uploaded By':u.name,'Guide Used':s.guide,Notes:info.note
    });

    if(!info.isExtra){
      const clean=externalPhotoDeactivateOldMainV5_(s,info.baseType,fileId,u);
      if(!clean){
        try{log_(u,'PHOTO_REPLACE_WARNING',s.key,info.baseType+' old metadata cleanup incomplete; new photo remains active.')}catch(_){}
      }
    }

    try{log_(u,'PHOTO_V5',s.key,info.type)}catch(_){}
    return {
      ok:true,type:info.type,baseType:info.baseType,isExtra:info.isExtra,
      fileId:fileId,url:fileUrl,
      previewUrl:'https://drive.google.com/thumbnail?id='+encodeURIComponent(fileId)+'&sz=w1600',
      name:actualName,folderId:expectedFolderId,folderUrl:driveFolderUrl_(expectedFolderId),
      uploadedAt:now_(),duplicateRequest:false,transport:'V5_DIRECT_DRIVE_RESERVED',
      bytes:bytes,mime:String(f.getMimeType()||info.mime||'')
    };
  }finally{
    try{lock.releaseLock()}catch(_){}
  }
}
