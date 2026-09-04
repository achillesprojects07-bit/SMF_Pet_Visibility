import crypto from 'node:crypto';
import {sheetRows,appendObject,updateObject,ensureFolder,getFolder,findFile,createFile,fileInfo} from './google.js';

export const TAB={CONFIG:'V4_CONFIG',USERS:'V4_USERS',STORES:'V4_STORES',POE:'V4_POE',PHOTOS:'V4_PHOTOS',ACTIVITY:'V4_ACTIVITY'};
export const mode=()=>String(process.env.APP_MODE||'LIVE').toUpperCase()==='DEMO'?'DEMO':'LIVE';
const truth=v=>v===true||String(v).toUpperCase()==='TRUE'||String(v)==='1';
const safe=s=>String(s||'').replace(/[\\/:*?"<>|#%{}[\]]/g,' ').replace(/\s+/g,' ').trim().slice(0,90)||'UNKNOWN';
const now=()=>new Date().toISOString();
const parse=(v,d={})=>{try{return JSON.parse(String(v||''))}catch{return d}};

export async function authCode(code){
  const {rows}=await sheetRows(TAB.USERS);
  const u=rows.find(x=>String(x['Access Code']||'').trim().toUpperCase()===String(code||'').trim().toUpperCase()&&truth(x.Active));
  if(!u)throw Object.assign(new Error('Access code not recognized or inactive.'),{status:401});
  const role=String(u.Role||'').toUpperCase();
  if(role!=='FIELD')throw Object.assign(new Error('v5 field pilot accepts FIELD accounts only.'),{status:403});
  return {row:u._row,name:String(u['Display Name']||''),role,team:String(u['Assigned Team']||'')};
}
export async function validateFieldSession(user){
  const {rows}=await sheetRows(TAB.USERS);
  const u=rows.find(x=>Number(x._row)===Number(user?.row));
  if(!u||!truth(u.Active)||String(u.Role||'').toUpperCase()!=='FIELD'){
    throw Object.assign(new Error('Session is no longer authorized.'),{status:401});
  }
  const team=String(u['Assigned Team']||'');
  if(team!==String(user?.team||'')){
    throw Object.assign(new Error('Your team assignment changed. Sign in again.'),{status:401});
  }
  return {row:u._row,name:String(u['Display Name']||''),role:'FIELD',team};
}

export async function stores(){
  const {rows}=await sheetRows(TAB.STORES);
  return rows.filter(x=>truth(x.Active)).map(x=>({
    _row:x._row,storeId:String(x['Store ID']||'').trim().toUpperCase(),key:String(x['Store Key']||''),
    name:String(x['Store Name']||''),team:String(x['Assigned Team']||''),day:String(x.Day||''),stop:Number(x['Stop No.']||0),
    category:String(x['Store Category']||''),address:String(x.Address||''),barangay:String(x.Barangay||''),area:String(x.Area||''),
    allocation:String(x['Material Allocation']||''),materials:parse(x['Material JSON'],{}),pending:truth(x.Pending),
    guide:String(x['Effective Rule']||x['Override Rule']||x['Category Rule']||'REVIEW')
  }));
}
export async function poeMap(){
  const {rows}=await sheetRows(TAB.POE);const m={};rows.filter(x=>String(x.Environment||'').toUpperCase()===mode()).forEach(x=>m[String(x['Store Key']||'')]=x);return m;
}
export async function activePhotos(){
  const {rows}=await sheetRows(TAB.PHOTOS);return rows.filter(x=>String(x.Environment||'').toUpperCase()===mode()&&truth(x.Active));
}
export function outcome(p){
  const s=String(p?.['Store Status']||'').toUpperCase();return ['COMPLETED','INCOMPLETE','REFUSED','CLOSED'].includes(s)?s:'OPEN';
}
export const isFinal=p=>['COMPLETED','INCOMPLETE','REFUSED','CLOSED'].includes(outcome(p));
export function displayDay(s,p){return String(p?.['Reschedule Day']||'').trim()||s.day}
export async function storeByKey(key){const s=(await stores()).find(x=>x.key===String(key));if(!s)throw Object.assign(new Error('Store not found.'),{status:404});return s}
export function photoRequirements(s){
  const qty=n=>Number(s.materials?.[n]||0);
  const a=[
    {type:'STOREFRONT',label:'Storefront / Store Identification'},
    {type:'BEFORE_WIDE',label:'Before — Full Merchandising Area'},
    {type:'AFTER_WIDE',label:'After — Full Completed Execution'},
    {type:'AFTER_CLOSE',label:'After — Close-up / Quality Check'}
  ];
  const add=(type,label)=>{if(!a.some(x=>x.type===type))a.push({type,label})};
  const hasPrice=Object.keys(s.materials||{}).some(k=>/^Price /i.test(k)&&Number(s.materials[k]||0)>0);
  if(['FEED','PET_SHOP_GT'].includes(s.guide)){
    add('PRODUCT_DISPLAY','Product Display / Brand Blocking');
    if(hasPrice)add('PRICE_STICKS','Price Sticks');
    if(qty('Posters'))add('POSTERS','Posters');if(qty('Available Here'))add('AVAILABLE_HERE','Available Here');
    if(qty('Banner'))add('BANNER','Horizontal Banner');if(qty('Flyers'))add('FLYERS','Flyers');
  }else if(s.guide==='PET_SHOP_MT'){
    if(qty('Available Here'))add('AVAILABLE_HERE','Available Here');if(qty('Posters'))add('POSTERS','Posters');if(qty('Flyers'))add('FLYERS','Flyers');
  }else if(s.guide==='VET'){
    if(qty('Available Here'))add('AVAILABLE_HERE','Available Here');if(qty('Banner'))add('BANNER','Horizontal Banner');if(qty('Posters'))add('POSTERS','Posters');if(qty('Flyers'))add('FLYERS','Flyers');
  }else if(s.guide==='MODERN_TRADE'){
    add('SHELF_WIDE','Shelf / Product Facing — Wide');if(qty('Shelf Strip'))add('SHELF_STRIP','Shelf / Price Strips');if(qty('Wobbler'))add('WOBBLER','Wobblers');
  }
  return a;
}

export async function configMap(){
  const {rows}=await sheetRows(TAB.CONFIG);const m={};rows.forEach(x=>m[String(x.Key||'')]=x);return m;
}
export function daySubmitKey(team,day){return `DAY_SUBMIT|${mode()}|${String(team||'')}|${String(day||'')}`}
export async function getDaySubmission(team,day){
  const m=await configMap(),r=m[daySubmitKey(team,day)];if(!r||!String(r.Value||''))return null;
  try{return JSON.parse(String(r.Value||''))}catch{return {submittedAt:String(r.Value||''),submittedBy:''}}
}
async function setConfig(key,value,purpose){
  const {rows}=await sheetRows(TAB.CONFIG),r=rows.find(x=>String(x.Key||'')===key);
  const obj={Key:key,Value:String(value),Purpose:purpose||'',Updated:now()};
  if(r)await updateObject(TAB.CONFIG,r._row,obj);else await appendObject(TAB.CONFIG,obj);
}

export async function fieldHome(user){
  const all=(await stores()).filter(s=>s.team===user.team),pm=await poeMap();
  const enriched=all.map(s=>{const p=pm[s.key]||{};const o=outcome(p);return {...s,displayDay:displayDay(s,p),outcome:o,finalized:isFinal(p)}});
  const days=[...new Set(enriched.map(x=>x.displayDay))];
  const dayStatus={};
  for(const day of days){
    const rows=enriched.filter(x=>x.displayDay===day),finalized=rows.filter(x=>x.finalized).length;
    const raw=await getDaySubmission(user.team,day),sub=finalized===rows.length?raw:null;
    dayStatus[day]={total:rows.length,finalized,open:rows.length-finalized,submitted:!!sub,submittedAt:sub?.submittedAt||'',submittedBy:sub?.submittedBy||''};
  }
  return {stores:enriched,dayStatus};
}

export async function submitDay(user,day){
  day=String(day||'').trim();if(!day||day==='ALL')throw new Error('Choose one deployment day before submitting the day.');
  const all=(await stores()).filter(s=>s.team===user.team),pm=await poeMap();
  const rows=all.filter(s=>displayDay(s,pm[s.key]||{})===day);
  if(!rows.length)throw new Error('No stores are scheduled for '+day+'.');
  const open=rows.filter(s=>!isFinal(pm[s.key]||{}));
  if(open.length)throw new Error(`${open.length} store visit${open.length===1?' is':'s are'} still OPEN.`);
  const existing=await getDaySubmission(user.team,day);
  if(existing)return {ok:true,alreadySubmitted:true,day,submittedAt:existing.submittedAt||'',submittedBy:existing.submittedBy||''};
  const record={submittedAt:now(),submittedBy:user.name,team:user.team,day,total:rows.length};
  await setConfig(daySubmitKey(user.team,day),JSON.stringify(record),'Field deployment day submission');
  await activity(user,'SUBMIT_DAY','',`${day} • ${rows.length} store visits finalized`);
  return {ok:true,...record};
}

export async function storeDetail(user,key){
  const s=await storeByKey(key);if(s.team!==user.team)throw Object.assign(new Error('Store is not assigned to your team.'),{status:403});
  const pm=await poeMap(),p=pm[s.key]||{},photos=(await activePhotos()).filter(x=>String(x['Store Key']||'')===s.key);
  const main={};photos.forEach(x=>{const t=String(x['Photo Type']||'');if(!t.startsWith('EXTRA__'))main[t]={type:t,fileId:String(x['File ID']||''),url:String(x['File URL']||''),name:String(x['File Name']||'')}});
  return {store:s,poe:{finalized:isFinal(p),outcome:outcome(p),notes:String(p.Notes||''),inventory:{beginning:parse(p['Beginning JSON'],{}),installed:parse(p['Installed JSON'],{}),remaining:parse(p['Take Home JSON'],{})}},photos:main,photoRequirements:photoRequirements(s)};
}
export async function saveDraft(user,p){
  const s=await storeByKey(p.storeKey);if(s.team!==user.team)throw Object.assign(new Error('Store is not assigned to your team.'),{status:403});
  const pm=await poeMap(),old=pm[s.key];if(old&&isFinal(old))throw new Error('This store is finalized and read-only.');
  const obj={Environment:mode(),'Store Key':s.key,'Store Name':s.name,Team:s.team,'Store Status':'OPEN','Beginning JSON':JSON.stringify(p.beginning||{}),'Installed JSON':JSON.stringify(p.installed||{}),'Take Home JSON':JSON.stringify(p.takeHome||{}),Notes:String(p.notes||''),'Updated At':now(),'Guide Used':s.guide};
  if(old)await updateObject(TAB.POE,old._row,obj);else await appendObject(TAB.POE,obj);return {ok:true};
}
function validateInventory(s,p){
  for(const [k,a0] of Object.entries(s.materials||{})){
    const alloc=Number(a0||0);if(alloc<=0)continue;
    const bv=p.beginning?.[k],iv=p.installed?.[k],rv=p.takeHome?.[k];
    if(bv===''||bv===null||typeof bv==='undefined')throw new Error(`Enter beginning quantity for ${k}`);
    if(iv===''||iv===null||typeof iv==='undefined')throw new Error(`Enter installed quantity for ${k}`);
    if(rv===''||rv===null||typeof rv==='undefined')throw new Error(`Remaining quantity is missing for ${k}`);
    const b=Number(bv),i=Number(iv),r=Number(rv);
    if([b,i,r].some(x=>!Number.isFinite(x)||x<0))throw new Error(`Invalid quantity for ${k}`);
    if(b>alloc)throw new Error(`${k}: Beginning cannot be greater than allocated quantity (${alloc}).`);
    if(b!==i+r)throw new Error(`${k}: Beginning must equal Installed + Remaining.`);
  }
}
export async function submitStore(user,p){
  const s=await storeByKey(p.storeKey);if(s.team!==user.team)throw Object.assign(new Error('Store is not assigned to your team.'),{status:403});
  const status=String(p.status||'').toUpperCase();if(!['COMPLETED','INCOMPLETE','REFUSED','CLOSED'].includes(status))throw new Error('Choose a final visit outcome.');
  const pm=await poeMap(),old=pm[s.key];if(old&&isFinal(old))throw new Error('This store already has a final status.');
  const notes=String(p.notes||'').trim(),photos=(await activePhotos()).filter(x=>String(x['Store Key']||'')===s.key),have=new Set(photos.filter(x=>!String(x['Photo Type']||'').startsWith('EXTRA__')).map(x=>String(x['Photo Type']||'')));
  if(status==='COMPLETED'){
    if(s.pending)throw new Error('POSM allocation is pending. This store cannot be completed.');
    if(s.guide==='REVIEW')throw new Error('Merchandising guide needs Admin review.');
    validateInventory(s,p);
    const missing=photoRequirements(s).filter(x=>!have.has(x.type));if(missing.length)throw new Error('Missing POE: '+missing.map(x=>x.label).join('; '));
  }else{
    if(!notes)throw new Error(status==='REFUSED'?'REFUSED requires Notes.':status==='CLOSED'?'STORE CLOSED requires Notes.':'INCOMPLETE requires Notes.');
    if(!have.has('STOREFRONT'))throw new Error('Storefront / store identification photo is required.');
    if(status==='INCOMPLETE'&&!photos.some(x=>{const t=String(x['Photo Type']||'');return t!=='STOREFRONT'&&!t.startsWith('EXTRA__STOREFRONT__')}))throw new Error('INCOMPLETE requires at least one additional evidence photo.');
  }
  const obj={Environment:mode(),'Store Key':s.key,'Store Name':s.name,Team:s.team,'Store Status':status,'Beginning JSON':JSON.stringify(p.beginning||{}),'Installed JSON':JSON.stringify(p.installed||{}),'Take Home JSON':JSON.stringify(p.takeHome||{}),Completed:status==='COMPLETED','Completed At':now(),'Completed By':user.name,'Updated At':now(),'Guide Used':s.guide,Notes:notes};
  if(old)await updateObject(TAB.POE,old._row,obj);else await appendObject(TAB.POE,obj);
  await activity(user,'SUBMIT_STORE_VISIT',s.key,status);return {ok:true,status};
}
async function activity(user,action,key,details){await appendObject(TAB.ACTIVITY,{Timestamp:now(),Environment:mode(),User:user.name,Role:user.role,Action:action,'Store Key':key||'',Details:details||''})}
function tokenSuffix(token){return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0,16).toUpperCase()}
async function existingFolderForStore(key){
  const {rows}=await sheetRows(TAB.PHOTOS);const hit=rows.find(x=>String(x.Environment||'').toUpperCase()===mode()&&String(x['Store Key']||'')===key&&String(x['Folder ID']||''));if(!hit)return null;
  try{return await getFolder(String(hit['Folder ID']))}catch{return null}
}
export async function uploadPhoto(user,{storeKey,photoType,addAnother,uploadToken,file}){
  const s=await storeByKey(storeKey);if(s.team!==user.team)throw Object.assign(new Error('Store is not assigned to your team.'),{status:403});
  const pm=await poeMap();if(pm[s.key]&&isFinal(pm[s.key]))throw new Error('This store is finalized and read-only.');
  if(!uploadToken)throw new Error('Upload token missing.');
  if(!file?.buffer?.length)throw new Error('No photo received.');
  if(file.size>12*1024*1024)throw new Error('Photo is over 12 MB.');
  const baseType=String(photoType||'').toUpperCase(),valid=photoRequirements(s).map(x=>x.type);if(!valid.includes(baseType))throw new Error('Invalid photo type.');
  const note='UPLOAD_TOKEN:'+uploadToken;
  const {rows:allPhotoRows}=await sheetRows(TAB.PHOTOS);
  const existing=allPhotoRows.find(x=>String(x.Environment||'').toUpperCase()===mode()&&String(x['Store Key']||'')===s.key&&String(x.Notes||'')===note&&truth(x.Active));
  if(existing)return {ok:true,photo:{type:String(existing['Photo Type']||baseType),fileId:String(existing['File ID']||''),url:String(existing['File URL']||''),name:String(existing['File Name']||'')},duplicate:true};

  let storeFolder=await existingFolderForStore(s.key);
  if(!storeFolder){
    const env=await ensureFolder(process.env.POE_ROOT_FOLDER_ID,mode());
    const team=await ensureFolder(env.id,s.team);
    const area=await ensureFolder(team.id,safe(s.area));
    storeFolder=await ensureFolder(area.id,s.storeId?`${s.storeId} - ${safe(s.name)}`:safe(s.name));
  }
  const suffix=tokenSuffix(uploadToken),type=String(addAnother)==='1'?`EXTRA__${baseType}__${suffix.slice(0,8)}`:baseType;
  const ext=(String(file.originalname||'').match(/\.([A-Za-z0-9]{2,5})$/)?.[1]||'jpg').toLowerCase();
  const name=`${safe(s.name)}_${type}_${suffix}.${ext}`;
  let f=await findFile(storeFolder.id,name);if(!f)f=await createFile(storeFolder.id,name,file.mimetype,file.buffer);
  const row={Environment:mode(),'Store Key':s.key,'Store Name':s.name,Team:s.team,'Photo Type':type,'File ID':f.id,'File Name':name,'File URL':f.webViewLink||`https://drive.google.com/file/d/${f.id}/view`,'Folder ID':storeFolder.id,Active:true,'Uploaded At':now(),'Uploaded By':user.name,'Guide Used':s.guide,Notes:note};
  await appendObject(TAB.PHOTOS,row);
  if(String(addAnother)!=='1'){
    const fresh=await sheetRows(TAB.PHOTOS);
    for(const x of fresh.rows){
      if(String(x.Environment||'').toUpperCase()===mode()&&String(x['Store Key']||'')===s.key&&String(x['Photo Type']||'')===baseType&&truth(x.Active)&&String(x.Notes||'')!==note){
        await updateObject(TAB.PHOTOS,x._row,{Active:false,Notes:`Replaced by ${user.name} at ${now()}`});
      }
    }
  }
  await activity(user,'PHOTO_V5',s.key,type);
  return {ok:true,photo:{type,fileId:f.id,url:row['File URL'],name}};
}
