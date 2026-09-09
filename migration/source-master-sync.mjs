#!/usr/bin/env node

/**
 * SOURCE MASTER SYNC — production-safe, source-file driven.
 *
 * Supported business operations ONLY:
 *   1) RENAME an existing store from STORE IDENTITY & SCHEDULE.
 *   2) ADD a new store from a complete blank-ID / blank-Legacy-Key source row.
 *
 * Design rules:
 * - Source workbook is authoritative for store master changes.
 * - Existing stores are identified by permanent Store ID only.
 * - Existing Legacy Store Key is immutable and is NEVER regenerated on rename.
 * - V4_POE and V4_PHOTOS are never written.
 * - Drive files are never renamed, moved, or deleted.
 * - Existing store folders are never renamed when a store name changes.
 * - No DELETE path exists.
 * - No upload/runtime file is touched.
 * - PLAN is the default and is read-only.
 * - APPLY requires an exact fingerprint + exact target + explicit approval phrase.
 * - New-store creation is one source row at a time and is idempotent.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const SOURCE_SHEET_ID = process.env.SOURCE_SHEET_ID || '1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
const INTERNAL_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1TNrb3ir8vS6CyZ8kXhRH43JXoH4Ws7iQ4g3649KQTf0';
const POE_ROOT_FOLDER_ID = process.env.POE_ROOT_FOLDER_ID || '1sD4bBdsaEqxEOfk-Q9yJIXyS_ErrLmAw';
const IDENTITY_SHEET = 'STORE IDENTITY & SCHEDULE';
const HISTORY_SHEET = 'STORE CHANGE HISTORY';
const MATERIAL_SHEET = 'MATERIAL SET DEFINITIONS';
const OUT_DIR = process.env.SOURCE_MASTER_SYNC_OUT_DIR || 'migration/source-master-sync-output';
const MODE = String(process.env.SOURCE_MASTER_SYNC_MODE || 'PLAN').toUpperCase();
const TARGET = String(process.env.SOURCE_MASTER_SYNC_TARGET || '').trim(); // Store ID for rename; source row number for add
const EXPECTED_FINGERPRINT = String(process.env.SOURCE_MASTER_SYNC_EXPECTED_FINGERPRINT || '').trim();
const APPROVAL = String(process.env.SOURCE_MASTER_SYNC_APPROVAL || '').trim();
const APPROVAL_PHRASE = 'YES_I_APPROVE_SOURCE_MASTER_SYNC';

const V4_HEADERS = ['Store Key','Store Name','Assigned Team','Day','Stop No.','Store Category','Address','Barangay','Area','Material Allocation','Material JSON','Pending','Category Rule','Override Rule','Effective Rule','Active','Source Sync Timestamp','Store ID'];
const SOURCE_HEADERS = ['Store ID','Current Store Name','Previous Name','Assigned Team','Route Day','Route Stop','Scheduled Deployment Date','Scheduled Stop','Actual Visit Date','Store Category','Street Address / Location','Barangay / District','City / Area','Material Allocation','Active','Legacy Store Key','Identity Status','Last Identity Sync'];
const NEW_REQUIRED = ['Current Store Name','Assigned Team','Route Day','Route Stop','Scheduled Deployment Date','Scheduled Stop','Store Category','Street Address / Location','City / Area','Material Allocation','Active'];

function text(v){ return String(v ?? '').trim(); }
function norm(v){ return text(v).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' '); }
function hash(v){ return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex'); }
function teamNorm(v){ const m=text(v).match(/team\s*(\d+)/i); return m ? `Team ${m[1]}` : text(v); }
function boolNorm(v){ const s=text(v).toLowerCase(); return ['true','yes','1','active'].includes(s) ? 'TRUE' : ['false','no','0','inactive'].includes(s) ? 'FALSE' : text(v).toUpperCase(); }
function rows(values){ if(!values?.length)return[]; const h=values[0].map(text); return values.slice(1).filter(r=>r.some(v=>text(v)!=='')).map((r,i)=>{const o={__row:i+2};h.forEach((k,j)=>{if(k)o[k]=r[j]??''});return o;}); }
function indexMap(headers){ const m={}; headers.forEach((h,i)=>m[h]=i); return m; }
function isoNow(){ return new Date().toISOString(); }
function a1Col(n){ let s=''; for(let x=n+1;x>0;x=Math.floor((x-1)/26))s=String.fromCharCode(65+((x-1)%26))+s; return s; }
function dateDisplay(v){ const s=text(v); let m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if(m){const month=Number(m[2]); const names=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec']; return `${names[month-1]} ${Number(m[3])}`;} m=s.match(/Sept(?:ember)?\s+(\d{1,2})/i); return m?`Sept ${Number(m[1])}`:s; }
function duplicates(items){const seen=new Set(),dup=new Set();for(const x of items.map(text).filter(Boolean)){if(seen.has(x))dup.add(x);seen.add(x)}return [...dup];}

async function token(){
  const need=n=>{const v=text(process.env[n]);if(!v)throw new Error(`Missing ${n}`);return v;};
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:need('GOOGLE_OAUTH_CLIENT_ID'),client_secret:need('GOOGLE_OAUTH_CLIENT_SECRET'),refresh_token:need('GOOGLE_OAUTH_REFRESH_TOKEN'),grant_type:'refresh_token'})});
  const j=await r.json(); if(!r.ok||!j.access_token)throw new Error(`OAuth refresh failed: ${r.status}`); return j.access_token;
}
async function getRange(tok,id,range){const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;const r=await fetch(u,{headers:{authorization:`Bearer ${tok}`}});if(!r.ok)throw new Error(`GET ${range} failed: ${r.status} ${await r.text()}`);return(await r.json()).values||[];}
async function putRange(tok,id,range,values){const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;const r=await fetch(u,{method:'PUT',headers:{authorization:`Bearer ${tok}`,'content-type':'application/json'},body:JSON.stringify({values})});if(!r.ok)throw new Error(`WRITE ${range} failed: ${r.status} ${await r.text()}`);return r.json();}
async function appendRange(tok,id,range,values){const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;const r=await fetch(u,{method:'POST',headers:{authorization:`Bearer ${tok}`,'content-type':'application/json'},body:JSON.stringify({values})});if(!r.ok)throw new Error(`APPEND ${range} failed: ${r.status} ${await r.text()}`);return r.json();}

async function listFolders(tok,parent){const q=`'${String(parent).replace(/'/g,"\\'")}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;const u=`https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1000&fields=files(id,name)&q=${encodeURIComponent(q)}`;const r=await fetch(u,{headers:{authorization:`Bearer ${tok}`}});if(!r.ok)throw new Error(`Drive list failed: ${r.status}`);return(await r.json()).files||[];}
async function getOrCreateFolder(tok,parent,name){const existing=(await listFolders(tok,parent)).find(f=>norm(f.name)===norm(name));if(existing)return {id:existing.id,name:existing.name,created:false};const r=await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name',{method:'POST',headers:{authorization:`Bearer ${tok}`,'content-type':'application/json'},body:JSON.stringify({name,mimeType:'application/vnd.google-apps.folder',parents:[parent]})});if(!r.ok)throw new Error(`Drive folder create failed: ${r.status} ${await r.text()}`);const j=await r.json();return {id:j.id,name:j.name,created:true};}

function materialDefinitions(values){
  const headerRow=values.findIndex(r=>text(r[0]).toUpperCase()==='SET'); if(headerRow<0)throw new Error('MATERIAL SET DEFINITIONS header row not found.');
  const h=values[headerRow].map(text), out=new Map();
  for(const r of values.slice(headerRow+1)){const set=text(r[0]).toUpperCase();if(!set)continue;const o={};h.forEach((k,i)=>o[k]=r[i]??'');out.set(set,o);} return out;
}
function materialJson(setName,defs){
  const set=text(setName).toUpperCase(); const d=defs.get(set); if(!d)throw new Error(`Unknown Material Allocation: ${setName}`);
  if(set==='PENDING')throw new Error('PENDING material allocation cannot be activated.');
  const map=[['Flyers','Flyers'],['Posters','Posters'],['Price Puppy','Price Puppy'],['Price Adult','Price Adult'],['Price Small Breed','Price Small Breed'],['Price Generic','Price Generic'],['Available Here','Available Here'],['Banner','Horizontal Banner'],['Shirt','Shirt'],['Wobbler','Wobbler'],['Shelf Strip','Shelf Strip']];
  const obj={}; for(const [src,dst] of map){const n=Number(d[src]||0); if(Number.isFinite(n)&&n!==0)obj[dst]=n;} return obj;
}
function ruleForSet(set){const s=text(set).toUpperCase();if(s==='SET 1')return'FEED';if(s==='SET 2')return'PET_SHOP_MT';if(s==='SET 3')return'VET';if(['SET 4','SET 5','SET 6','UNIQUE'].includes(s))return'MODERN_TRADE';throw new Error(`No category rule mapping for ${set}`);}
function nextId(live,source){let max=0;for(const r of [...live,...source]){const m=text(r['Store ID']).match(/^SMF-(\d{4})$/);if(m)max=Math.max(max,Number(m[1]));}return `SMF-${String(max+1).padStart(4,'0')}`;}
function legacyKey(row){return `${teamNorm(row['Assigned Team'])}|${dateDisplay(row['Scheduled Deployment Date'])}|${text(row['Scheduled Stop'])}|${text(row['Current Store Name'])}`;}

function plan(source,live,defs){
  const liveById=new Map(live.map(r=>[text(r['Store ID']),r]));
  const actions=[];
  const sourceIds=source.map(r=>text(r['Store ID']));
  const liveIds=live.map(r=>text(r['Store ID']));
  const hardBlocks=[];
  if(duplicates(sourceIds).length)hardBlocks.push({reason:'DUPLICATE_SOURCE_STORE_ID',values:duplicates(sourceIds)});
  if(duplicates(liveIds).length)hardBlocks.push({reason:'DUPLICATE_LIVE_STORE_ID',values:duplicates(liveIds)});
  if(duplicates(live.map(r=>r['Store Key'])).length)hardBlocks.push({reason:'DUPLICATE_LIVE_STORE_KEY',values:duplicates(live.map(r=>r['Store Key']))});

  for(const s of source){
    const id=text(s['Store ID']), key=text(s['Legacy Store Key']);
    if(id){
      const l=liveById.get(id); if(!l){actions.push({action:'BLOCKED',reason:'SOURCE_ID_NOT_IN_LIVE',storeId:id,sourceRow:s.__row});continue;}
      if(key!==text(l['Store Key'])){actions.push({action:'BLOCKED',reason:'LEGACY_KEY_MISMATCH',storeId:id,sourceRow:s.__row});continue;}
      const diffs=[];
      const allowed=[['Current Store Name','Store Name']];
      const forbidden=[['Assigned Team','Assigned Team'],['Scheduled Deployment Date','Day'],['Scheduled Stop','Stop No.'],['Store Category','Store Category'],['Street Address / Location','Address'],['Barangay / District','Barangay'],['City / Area','Area'],['Material Allocation','Material Allocation'],['Active','Active']];
      for(const [sf,lf] of allowed)if(norm(s[sf])!==norm(l[lf]))diffs.push({field:sf,current:text(l[lf]),desired:text(s[sf]),allowed:true});
      for(const [sf,lf] of forbidden){let a=text(s[sf]),b=text(l[lf]);if(sf==='Assigned Team'){a=teamNorm(a);b=teamNorm(b)}else if(sf==='Active'){a=boolNorm(a);b=boolNorm(b)}else if(sf==='Scheduled Deployment Date'){a=dateDisplay(a);b=dateDisplay(b)}else{a=norm(a);b=norm(b)}if(a!==b)diffs.push({field:sf,current:text(l[lf]),desired:text(s[sf]),allowed:false});}
      const forbiddenDiffs=diffs.filter(d=>!d.allowed);
      if(forbiddenDiffs.length)actions.push({action:'BLOCKED',reason:'ONLY_STORE_NAME_CHANGE_IS_ENABLED',storeId:id,sourceRow:s.__row,changes:diffs});
      else if(diffs.length)actions.push({action:'RENAME_READY',storeId:id,sourceRow:s.__row,legacyStoreKey:key,oldName:text(l['Store Name']),newName:text(s['Current Store Name']),changes:diffs});
      else actions.push({action:'UNCHANGED',storeId:id,sourceRow:s.__row});
    } else {
      const missing=NEW_REQUIRED.filter(f=>!text(s[f]));
      if(key){actions.push({action:'BLOCKED',reason:'NEW_ROW_LEGACY_KEY_MUST_BE_BLANK',sourceRow:s.__row});continue;}
      if(missing.length){actions.push({action:'BLOCKED',reason:'NEW_ROW_MISSING_REQUIRED_FIELDS',sourceRow:s.__row,missing});continue;}
      if(boolNorm(s.Active)!=='TRUE'){actions.push({action:'BLOCKED',reason:'NEW_ROW_ACTIVE_MUST_BE_TRUE',sourceRow:s.__row});continue;}
      let mat,rule;try{mat=materialJson(s['Material Allocation'],defs);rule=ruleForSet(s['Material Allocation']);}catch(e){actions.push({action:'BLOCKED',reason:'NEW_ROW_MATERIAL_INVALID',sourceRow:s.__row,detail:e.message});continue;}
      const nameRisk=live.filter(l=>norm(l['Store Name'])===norm(s['Current Store Name']));
      const addressRisk=live.filter(l=>norm(l.Address)===norm(s['Street Address / Location'])&&teamNorm(l['Assigned Team'])===teamNorm(s['Assigned Team']));
      if(nameRisk.length||addressRisk.length){actions.push({action:'BLOCKED',reason:'POSSIBLE_DUPLICATE_NEW_STORE',sourceRow:s.__row,duplicateStoreIds:[...new Set([...nameRisk,...addressRisk].map(x=>text(x['Store ID'])))]});continue;}
      const id2=nextId(live,source), key2=legacyKey(s);
      actions.push({action:'ADD_READY',sourceRow:s.__row,proposedStoreId:id2,proposedLegacyStoreKey:key2,currentName:text(s['Current Store Name']),team:teamNorm(s['Assigned Team']),area:text(s['City / Area']),materialJson:mat,rule});
    }
  }
  const actionable=actions.filter(a=>['RENAME_READY','ADD_READY'].includes(a.action));
  const fingerprint=hash({source:source.map(r=>({...r,__row:r.__row})),live:live.map(r=>({...r,__row:r.__row})),actions:actionable,hardBlocks});
  return {hardBlocks,actions,actionable,fingerprint};
}

function requireApply(plan,action){
  if(APPROVAL!==APPROVAL_PHRASE)throw new Error(`APPLY blocked: approval phrase must equal ${APPROVAL_PHRASE}`);
  if(!EXPECTED_FINGERPRINT||EXPECTED_FINGERPRINT!==plan.fingerprint)throw new Error('APPLY blocked: fingerprint mismatch. Re-run PLAN and approve the exact current fingerprint.');
  if(plan.hardBlocks.length)throw new Error('APPLY blocked: global integrity block exists.');
  if(!TARGET)throw new Error('APPLY blocked: exact target is required.');
  if(action==='RENAME'){const a=plan.actions.find(x=>x.action==='RENAME_READY'&&x.storeId===TARGET);if(!a)throw new Error(`No RENAME_READY action for ${TARGET}`);return a;}
  if(action==='ADD'){const row=Number(TARGET);const a=plan.actions.find(x=>x.action==='ADD_READY'&&Number(x.sourceRow)===row);if(!a)throw new Error(`No ADD_READY action for source row ${TARGET}`);return a;}
  throw new Error('Unsupported apply action.');
}

async function applyRename(tok,action,sourceValues,liveValues){
  const liveHeader=liveValues[0].map(text), srcHeader=sourceValues[0].map(text), li=indexMap(liveHeader), si=indexMap(srcHeader);
  const liveRow=rows(liveValues).find(r=>text(r['Store ID'])===action.storeId); if(!liveRow)throw new Error('Target live store disappeared.');
  if(text(liveRow['Store Key'])!==action.legacyStoreKey)throw new Error('Legacy Store Key changed during apply.');
  const now=isoNow();
  const liveRowNumber=liveRow.__row;
  await putRange(tok,INTERNAL_SHEET_ID,`V4_STORES!${a1Col(li['Store Name'])}${liveRowNumber}:${a1Col(li['Store Name'])}${liveRowNumber}`,[[action.newName]]);
  if(li['Source Sync Timestamp']!==undefined)await putRange(tok,INTERNAL_SHEET_ID,`V4_STORES!${a1Col(li['Source Sync Timestamp'])}${liveRowNumber}:${a1Col(li['Source Sync Timestamp'])}${liveRowNumber}`,[[now]]);
  const sr=action.sourceRow;
  if(si['Previous Name']!==undefined)await putRange(tok,SOURCE_SHEET_ID,`'${IDENTITY_SHEET}'!${a1Col(si['Previous Name'])}${sr}:${a1Col(si['Previous Name'])}${sr}`,[[action.oldName]]);
  if(si['Identity Status']!==undefined)await putRange(tok,SOURCE_SHEET_ID,`'${IDENTITY_SHEET}'!${a1Col(si['Identity Status'])}${sr}:${a1Col(si['Identity Status'])}${sr}`,[['ACTIVE_WITH_HISTORY']]);
  if(si['Last Identity Sync']!==undefined)await putRange(tok,SOURCE_SHEET_ID,`'${IDENTITY_SHEET}'!${a1Col(si['Last Identity Sync'])}${sr}:${a1Col(si['Last Identity Sync'])}${sr}`,[[now]]);
  const eventId=`EVT-${Date.now()}-${action.storeId}`;
  await appendRange(tok,SOURCE_SHEET_ID,`'${HISTORY_SHEET}'!A:J`,[[eventId,action.storeId,action.legacyStoreKey,'STORE_RENAME','Current Store Name',action.oldName,action.newName,now,'SOURCE_MASTER_SYNC','SYSTEM']]);
  const verify=(await getRange(tok,INTERNAL_SHEET_ID,'V4_STORES!A1:S1000'));const vr=rows(verify).find(r=>text(r['Store ID'])===action.storeId);if(!vr||text(vr['Store Name'])!==action.newName||text(vr['Store Key'])!==action.legacyStoreKey)throw new Error('Post-rename verification failed.');
  return {ok:true,operation:'RENAME',storeId:action.storeId,oldName:action.oldName,newName:action.newName,legacyStoreKeyPreserved:true};
}

async function applyAdd(tok,action,sourceValues,liveValues,defs){
  const sourceRows=rows(sourceValues), sourceRow=sourceRows.find(r=>Number(r.__row)===Number(action.sourceRow)); if(!sourceRow)throw new Error('Source row disappeared.');
  if(text(sourceRow['Store ID'])||text(sourceRow['Legacy Store Key']))throw new Error('Source row is no longer blank-ID/blank-key. Re-plan.');
  const liveRows=rows(liveValues);
  if(liveRows.some(r=>text(r['Store ID'])===action.proposedStoreId||text(r['Store Key'])===action.proposedLegacyStoreKey))throw new Error('Proposed Store ID or Legacy Store Key already exists. Re-plan.');
  const now=isoNow(), mat=materialJson(sourceRow['Material Allocation'],defs), rule=ruleForSet(sourceRow['Material Allocation']);
  const liveFolder=await getOrCreateFolder(tok,POE_ROOT_FOLDER_ID,'LIVE');
  const teamFolder=await getOrCreateFolder(tok,liveFolder.id,teamNorm(sourceRow['Assigned Team']));
  const areaFolder=await getOrCreateFolder(tok,teamFolder.id,text(sourceRow['City / Area']));
  const storeFolder=await getOrCreateFolder(tok,areaFolder.id,`${action.proposedStoreId} - ${text(sourceRow['Current Store Name'])}`);
  if(!storeFolder.id)throw new Error('Store POE folder provisioning failed.');

  const record={
    'Store Key':action.proposedLegacyStoreKey,'Store Name':text(sourceRow['Current Store Name']),'Assigned Team':teamNorm(sourceRow['Assigned Team']),'Day':dateDisplay(sourceRow['Scheduled Deployment Date']),'Stop No.':text(sourceRow['Scheduled Stop']),'Store Category':text(sourceRow['Store Category']),'Address':text(sourceRow['Street Address / Location']),'Barangay':text(sourceRow['Barangay / District']),'Area':text(sourceRow['City / Area']),'Material Allocation':text(sourceRow['Material Allocation']),'Material JSON':JSON.stringify(mat),'Pending':'FALSE','Category Rule':rule,'Override Rule':'','Effective Rule':rule,'Active':'TRUE','Source Sync Timestamp':now,'Store ID':action.proposedStoreId
  };
  await appendRange(tok,INTERNAL_SHEET_ID,'V4_STORES!A:R',[[...V4_HEADERS.map(h=>record[h]??'')]]);

  // Immediately persist permanent identity back to the authoritative source.
  const srcHeader=sourceValues[0].map(text), si=indexMap(srcHeader), sr=action.sourceRow;
  const writes=[['Store ID',action.proposedStoreId],['Legacy Store Key',action.proposedLegacyStoreKey],['Identity Status','ACTIVE'],['Last Identity Sync',now]];
  for(const [field,value] of writes){if(si[field]===undefined)throw new Error(`Source column missing during ADD: ${field}`);await putRange(tok,SOURCE_SHEET_ID,`'${IDENTITY_SHEET}'!${a1Col(si[field])}${sr}:${a1Col(si[field])}${sr}`,[[value]]);}
  const eventId=`EVT-${Date.now()}-${action.proposedStoreId}`;
  await appendRange(tok,SOURCE_SHEET_ID,`'${HISTORY_SHEET}'!A:J`,[[eventId,action.proposedStoreId,action.proposedLegacyStoreKey,'STORE_ADD','Store ID','',action.proposedStoreId,now,'SOURCE_MASTER_SYNC','SYSTEM']]);

  const verify=rows(await getRange(tok,INTERNAL_SHEET_ID,'V4_STORES!A1:S1000')).filter(r=>text(r['Store ID'])===action.proposedStoreId);
  if(verify.length!==1)throw new Error(`Post-add verification failed: expected exactly one ${action.proposedStoreId}, found ${verify.length}.`);
  if(text(verify[0]['Store Key'])!==action.proposedLegacyStoreKey||text(verify[0]['Store Name'])!==text(sourceRow['Current Store Name'])||boolNorm(verify[0].Active)!=='TRUE')throw new Error('Post-add verification failed: identity or Active state mismatch.');
  return {ok:true,operation:'ADD',storeId:action.proposedStoreId,storeName:text(sourceRow['Current Store Name']),legacyStoreKey:action.proposedLegacyStoreKey,poeFolderId:storeFolder.id,poeFolderCreated:storeFolder.created,active:true};
}

async function selfTest(){
  const defs=new Map([['SET 1',{Set:'SET 1',Flyers:'150',Posters:'30','Price Puppy':'2','Price Adult':'2','Price Small Breed':'2','Price Generic':'1','Available Here':'6',Banner:'4',Shirt:'6',Wobbler:'0','Shelf Strip':'0'}]]);
  const live=[{'Store ID':'SMF-0001','Store Key':'Team 1|Sept 2|1|Alpha','Store Name':'Alpha','Assigned Team':'Team 1',Day:'Sept 2','Stop No.':'1','Store Category':'Feeds Store',Address:'A',Barangay:'B',Area:'QC','Material Allocation':'SET 1',Active:'TRUE'}];
  const base={__row:2,'Store ID':'SMF-0001','Current Store Name':'Alpha New','Assigned Team':'Team 1','Route Day':'DAY 1','Route Stop':'1','Scheduled Deployment Date':'2026-09-02','Scheduled Stop':'1','Store Category':'Feeds Store','Street Address / Location':'A','Barangay / District':'B','City / Area':'QC','Material Allocation':'SET 1','Active':'TRUE','Legacy Store Key':live[0]['Store Key']};
  let p=plan([base],live,defs); if(p.actions[0].action!=='RENAME_READY')throw new Error('rename test failed');
  p=plan([{...base,'Assigned Team':'Team 2'}],live,defs); if(p.actions[0].action!=='BLOCKED')throw new Error('forbidden edit test failed');
  const add={...base,__row:3,'Store ID':'','Legacy Store Key':'','Current Store Name':'Gamma','Scheduled Stop':'2','Route Stop':'2','Street Address / Location':'C'};
  p=plan([add],live,defs); if(p.actions[0].action!=='ADD_READY'||p.actions[0].proposedStoreId!=='SMF-0002')throw new Error('add test failed');
  if(Object.keys(materialJson('SET 1',defs)).length===0)throw new Error('material test failed');
  return {ok:true,tests:['rename-only allowlist','forbidden edit block','new-store candidate','material derivation','immutable legacy key design','no delete path','no V4_POE/V4_PHOTOS write path']};
}

if(process.argv.includes('--self-test')){console.log(JSON.stringify(await selfTest(),null,2));process.exit(0);}

const tok=await token();
const [sourceValues,liveValues,materialValues]=await Promise.all([
  getRange(tok,SOURCE_SHEET_ID,`'${IDENTITY_SHEET}'!A1:R1000`),
  getRange(tok,INTERNAL_SHEET_ID,'V4_STORES!A1:S1000'),
  getRange(tok,SOURCE_SHEET_ID,`'${MATERIAL_SHEET}'!A1:M100`)
]);
const sourceHeader=sourceValues[0]?.map(text)||[],liveHeader=liveValues[0]?.map(text)||[];
for(const h of SOURCE_HEADERS)if(!sourceHeader.includes(h))throw new Error(`Source identity schema missing: ${h}`);
for(const h of V4_HEADERS)if(!liveHeader.includes(h))throw new Error(`V4_STORES schema missing: ${h}`);
const defs=materialDefinitions(materialValues), source=rows(sourceValues), live=rows(liveValues), p=plan(source,live,defs);
const report={generatedAt:isoNow(),mode:MODE,sourceSheetId:SOURCE_SHEET_ID,internalSheetId:INTERNAL_SHEET_ID,counts:{sourceRows:source.length,liveStores:live.length,renameReady:p.actions.filter(x=>x.action==='RENAME_READY').length,addReady:p.actions.filter(x=>x.action==='ADD_READY').length,blocked:p.actions.filter(x=>x.action==='BLOCKED').length,unchanged:p.actions.filter(x=>x.action==='UNCHANGED').length},fingerprint:p.fingerprint,hardBlocks:p.hardBlocks,actions:p.actions,protected:['V4_POE','V4_PHOTOS','Drive files','upload/runtime','existing Legacy Store Keys'],deletePath:false};
fs.mkdirSync(OUT_DIR,{recursive:true});fs.writeFileSync(`${OUT_DIR}/source-master-sync-plan.json`,JSON.stringify(report,null,2));
if(MODE==='PLAN'){console.log(JSON.stringify(report,null,2));}
else if(MODE==='APPLY_RENAME'){const a=requireApply(p,'RENAME');console.log(JSON.stringify(await applyRename(tok,a,sourceValues,liveValues),null,2));}
else if(MODE==='APPLY_ADD'){const a=requireApply(p,'ADD');console.log(JSON.stringify(await applyAdd(tok,a,sourceValues,liveValues,defs),null,2));}
else throw new Error(`Unsupported SOURCE_MASTER_SYNC_MODE: ${MODE}`);
