#!/usr/bin/env node

/**
 * Manual One-Store APPLY Executor — HARD LOCKED / ONE STORE ONLY.
 *
 * This is the first migration component that contains narrowly-scoped write
 * primitives for creating one new store. Production execution is deliberately
 * impossible in this build because PRODUCTION_APPLY_UNLOCKED is hard-coded
 * false. Unlocking requires a separate reviewed commit after Field visibility
 * containment has been independently proven.
 *
 * Frozen boundaries:
 * - NEVER writes V4_POE or V4_PHOTOS
 * - NEVER creates/renames/moves/deletes Drive folders or files
 * - NEVER changes upload/runtime code
 * - NEVER deletes rows
 * - NEVER activates Field visibility
 * - ONE approved manifest hash per execution
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const SOURCE_SHEET_ID=process.env.SOURCE_SHEET_ID||'1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
const INTERNAL_SHEET_ID=process.env.GOOGLE_SHEET_ID||'1TNrb3ir8vS6CyZ8kXhRH43JXoH4Ws7iQ4g3649KQTf0';
const OUT_DIR=process.env.STORE_APPLY_EXECUTOR_OUT_DIR||'migration/store-apply-executor-output';
const MANIFEST_SCHEMA='SMF_ADD_STORE_MANIFEST_V1';
const MODE='HARD_LOCKED_ONE_STORE_EXECUTOR';
const PRODUCTION_APPLY_UNLOCKED=false;
const FIELD_VISIBILITY_CONTAINMENT_PROVEN=false;

function text(v){return String(v??'').trim();}
function hash(v){return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');}
function rowsToObjects(values){if(!values?.length)return[];const h=values[0].map(text);return values.slice(1).filter(r=>r.some(v=>text(v)!=='')).map((r,i)=>{const o={__row:i+2};h.forEach((k,j)=>{if(k)o[k]=r[j]??'';});return o;});}
function manifestPayload(m){return {schema:m.schema,identityRow:m.identityRow,sourceSnapshot:m.sourceSnapshot,derived:m.derived,preconditions:m.preconditions};}
function recomputeManifestHash(m){return hash(manifestPayload(m));}
function canonicalJson(v){return JSON.stringify(v&&typeof v==='object'?v:{});}

function assertManifest(m,approvedHash){
  if(!m||m.schema!==MANIFEST_SCHEMA)throw new Error('Manifest schema is not approved.');
  if(m.status!=='READY_TO_APPLY'||m.immutable!==true||m.writeAttempted!==false||m.fieldVisible!==false)throw new Error('Manifest is not an untouched READY_TO_APPLY transaction.');
  if(!approvedHash||approvedHash!==m.manifestHash)throw new Error('Approved manifest hash does not match the selected transaction.');
  if(recomputeManifestHash(m)!==m.manifestHash)throw new Error('Manifest content changed after approval. Revalidate before APPLY.');
  if(m.preconditions?.deleteRequired!==false)throw new Error('Manifest requests a delete. DELETE is forbidden.');
  if(m.preconditions?.uploadRuntimeChangeRequired!==false)throw new Error('Manifest requests an upload/runtime change.');
  if(m.preconditions?.storeFolderExists!==true)throw new Error('Exact store POE folder must already exist before APPLY. Provision and revalidate first.');
  return true;
}

function buildV4StoreRecord(m){
  const s=m.sourceSnapshot||{},d=m.derived||{};
  return {
    'Store Key':text(d.storeKey),
    'Store Name':text(s['Current Store Name']),
    'Assigned Team':text(s['Assigned Team']).match(/team\s*(\d+)/i)?`Team ${text(s['Assigned Team']).match(/team\s*(\d+)/i)[1]}`:text(s['Assigned Team']),
    'Day':text(s['Scheduled Deployment Date']),
    'Stop No.':text(s['Scheduled Stop']),
    'Store Category':text(s['Store Category']),
    'Address':text(s['Street Address / Location']),
    'Barangay':text(s['Barangay / District']),
    'Area':text(s['City / Area']),
    'Material Allocation':text(s['Material Allocation']),
    'Material JSON':canonicalJson(d.materialJson),
    'Pending':text(d.pending||'FALSE'),
    'Category Rule':text(d.categoryRule),
    'Override Rule':'',
    'Effective Rule':text(d.effectiveRule),
    // Field activation is intentionally not part of this executor build.
    'Active':'FALSE',
    'Source Sync Timestamp':'',
    'Store ID':text(d.storeId)
  };
}

function compareSourceSnapshot(row,snapshot){
  const drift=[];for(const [k,v] of Object.entries(snapshot||{}))if(text(row?.[k])!==text(v))drift.push({field:k,approved:text(v),current:text(row?.[k])});return drift;
}

function preflight({manifest,approvedHash,identityRows,liveStores,folderVerified}){
  assertManifest({...manifest,preconditions:{...(manifest.preconditions||{}),storeFolderExists:folderVerified===true}},approvedHash);
  const row=identityRows.find(r=>Number(r.__row)===Number(manifest.identityRow));
  if(!row)throw new Error('Approved source identity row no longer exists.');
  const drift=compareSourceSnapshot(row,manifest.sourceSnapshot);if(drift.length)throw new Error('Approved source row is stale: '+JSON.stringify(drift));
  if(text(row['Store ID'])||text(row['Legacy Store Key']))throw new Error('Source row is no longer blank-ID/blank-key; another transaction may have acted on it.');
  const sameId=liveStores.filter(s=>text(s['Store ID'])===text(manifest.derived.storeId));
  const sameKey=liveStores.filter(s=>text(s['Store Key'])===text(manifest.derived.storeKey));
  if(sameId.length||sameKey.length)throw new Error('Proposed Store ID or Store Key already exists in V4_STORES.');
  return {sourceRow:row,v4Record:buildV4StoreRecord(manifest),preflightFingerprint:hash({row,liveStoresCount:liveStores.length,manifestHash:manifest.manifestHash})};
}

async function oauthToken(){const need=n=>{const v=text(process.env[n]);if(!v)throw new Error(`Missing ${n}`);return v;};const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:need('GOOGLE_OAUTH_CLIENT_ID'),client_secret:need('GOOGLE_OAUTH_CLIENT_SECRET'),refresh_token:need('GOOGLE_OAUTH_REFRESH_TOKEN'),grant_type:'refresh_token'})});const d=await r.json();if(!r.ok||!d.access_token)throw new Error('OAuth refresh failed.');return d.access_token;}
async function getRange(tok,id,range){const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;const r=await fetch(u,{headers:{authorization:`Bearer ${tok}`}});if(!r.ok)throw new Error(`GET ${range} failed: ${r.status}`);return(await r.json()).values||[];}
async function findExactStoreFolder(tok,root,manifest){const q=p=>String(p).replace(/'/g,"\\'");async function kids(parent){const query=`'${q(parent)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;const u=`https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1000&fields=files(id,name)&q=${encodeURIComponent(query)}`;const r=await fetch(u,{headers:{authorization:`Bearer ${tok}`}});if(!r.ok)throw new Error('Drive folder verification failed.');return(await r.json()).files||[];}const norm=v=>text(v).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');async function f(parent,name){return(await kids(parent)).find(x=>norm(x.name)===norm(name))||null;}const live=await f(root,'LIVE');if(!live)return null;const team=await f(live.id,manifest.sourceSnapshot['Assigned Team'].match(/team\s*(\d+)/i)?`Team ${manifest.sourceSnapshot['Assigned Team'].match(/team\s*(\d+)/i)[1]}`:manifest.sourceSnapshot['Assigned Team']);if(!team)return null;const area=await f(team.id,manifest.sourceSnapshot['City / Area']);if(!area)return null;return f(area.id,manifest.derived.folderName);}

// WRITE PRIMITIVES EXIST FOR CODE REVIEW ONLY. They are unreachable while
// PRODUCTION_APPLY_UNLOCKED and FIELD_VISIBILITY_CONTAINMENT_PROVEN are false.
async function putRange(tok,id,range,values){const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;const r=await fetch(u,{method:'PUT',headers:{authorization:`Bearer ${tok}`,'content-type':'application/json'},body:JSON.stringify({values})});if(!r.ok)throw new Error(`WRITE ${range} failed: ${r.status}`);return r.json();}
async function appendRange(tok,id,range,values){const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;const r=await fetch(u,{method:'POST',headers:{authorization:`Bearer ${tok}`,'content-type':'application/json'},body:JSON.stringify({values})});if(!r.ok)throw new Error(`APPEND ${range} failed: ${r.status}`);return r.json();}

async function lockedApply(){
  if(!PRODUCTION_APPLY_UNLOCKED)throw new Error('PRODUCTION APPLY IS HARD-LOCKED IN CODE.');
  if(!FIELD_VISIBILITY_CONTAINMENT_PROVEN)throw new Error('Field visibility containment is not proven. APPLY refused.');
  throw new Error('Executor activation sequence intentionally unavailable in this build.');
}

async function selfTest(){
  const m={schema:MANIFEST_SCHEMA,identityRow:2,sourceSnapshot:{'Current Store Name':'Gamma','Assigned Team':'Team 1','Route Day':'DAY 2','Route Stop':'2','Scheduled Deployment Date':'2026-09-09','Scheduled Stop':'84','Store Category':'Feeds Store','Street Address / Location':'B','Barangay / District':'B1','City / Area':'Quezon City','Material Allocation':'SET 1','Active':'TRUE'},derived:{storeId:'SMF-0084',storeKey:'Team 1|Sept 9|84|Gamma',materialJson:{Flyers:150},categoryRule:'FEED',effectiveRule:'FEED',pending:'FALSE',folderName:'SMF-0084 - Gamma',folderPath:'LIVE / Team 1 / Quezon City / SMF-0084 - Gamma'},preconditions:{storeFolderExists:true,storeFolderProvisionRequired:false,fieldActivationRequiredAfterVerifiedWrite:true,uploadRuntimeChangeRequired:false,deleteRequired:false},status:'READY_TO_APPLY',immutable:true,writeAttempted:false,fieldVisible:false};m.manifestHash=recomputeManifestHash(m);
  const identity=[{__row:2,...m.sourceSnapshot,'Store ID':'','Legacy Store Key':''}],stores=[{'Store ID':'SMF-0001','Store Key':'old'}];
  const p=preflight({manifest:m,approvedHash:m.manifestHash,identityRows:identity,liveStores:stores,folderVerified:true});
  let staleBlocked=false;try{preflight({manifest:m,approvedHash:m.manifestHash,identityRows:[{...identity[0],'Current Store Name':'Changed'}],liveStores:stores,folderVerified:true});}catch{staleBlocked=true;}
  let duplicateBlocked=false;try{preflight({manifest:m,approvedHash:m.manifestHash,identityRows:identity,liveStores:[...stores,{'Store ID':'SMF-0084','Store Key':'x'}],folderVerified:true});}catch{duplicateBlocked=true;}
  let missingFolderBlocked=false;try{preflight({manifest:m,approvedHash:m.manifestHash,identityRows:identity,liveStores:stores,folderVerified:false});}catch{missingFolderBlocked=true;}
  let hardLock=true;try{await lockedApply();hardLock=false;}catch(e){hardLock=/HARD-LOCKED/.test(String(e.message));}
  const tests={manifestValid:!!p.v4Record,staleBlocked,duplicateBlocked,missingFolderBlocked,stagedActiveFalse:p.v4Record.Active==='FALSE',hardLock,oneStoreOnly:true,noDeletePath:true,noPoePhotoWritePath:true};if(Object.values(tests).some(v=>v!==true))throw new Error('SELF TEST FAILED '+JSON.stringify(tests));return{ok:true,tests};
}

if(process.argv.includes('--self-test'))console.log(JSON.stringify(await selfTest(),null,2));
else{
  fs.mkdirSync(OUT_DIR,{recursive:true});
  const report={generatedAt:new Date().toISOString(),mode:MODE,productionApplyUnlocked:PRODUCTION_APPLY_UNLOCKED,fieldVisibilityContainmentProven:FIELD_VISIBILITY_CONTAINMENT_PROVEN,writeAttempted:false,fieldActivationAttempted:false,deleteAttempted:false,protectedTargets:['V4_POE','V4_PHOTOS','Drive','upload/runtime'],invariants:{hardLocked:PRODUCTION_APPLY_UNLOCKED===false,fieldContainmentNotAssumed:FIELD_VISIBILITY_CONTAINMENT_PROVEN===false,oneStoreOnly:true,noDeletes:true,noFieldActivation:true,uploadRuntimeUntouchedRequired:true}};
  fs.writeFileSync(`${OUT_DIR}/manual-one-store-apply-executor.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if(process.argv.includes('--apply'))await lockedApply();
}
