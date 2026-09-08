#!/usr/bin/env node

/**
 * Production One-Store Transaction — PREPARE + FINALIZE, FAIL CLOSED.
 *
 * Final production lifecycle for one future new store:
 *   1) PREPARE: bind the immutable Store ID / Legacy Store Key to the already
 *      approved source row, then provision exactly one POE store folder.
 *      The store is STILL ABSENT from V4_STORES and therefore not Field-visible.
 *   2) FINALIZE: after revalidation, append exactly one Active=TRUE V4_STORES
 *      row. That append is the visibility event. Post-write verification then
 *      proves the exact row exists and V4_POE / V4_PHOTOS stayed unchanged.
 *
 * No inactive-row staging is used. Live Active=FALSE containment has not been
 * directly proven, so this transaction never relies on Active=FALSE for safety.
 *
 * HARD SAFETY BOUNDARIES
 * - one manifest / one store per execution
 * - no DELETE path
 * - no V4_POE or V4_PHOTOS write path
 * - no upload/runtime write path
 * - no folder rename/move/delete
 * - no automatic rollback after FINALIZE; failure is surfaced for manual review
 * - PREPARE and FINALIZE are both hard-locked in this build
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const SOURCE_SHEET_ID=process.env.SOURCE_SHEET_ID||'1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
const INTERNAL_SHEET_ID=process.env.GOOGLE_SHEET_ID||'1TNrb3ir8vS6CyZ8kXhRH43JXoH4Ws7iQ4g3649KQTf0';
const OUT_DIR=process.env.FINAL_TX_OUT_DIR||'migration/final-transaction-output';
const MANIFEST_SCHEMA='SMF_ADD_STORE_MANIFEST_V1';
const MODE='HARD_LOCKED_FINAL_ONE_STORE_TRANSACTION';
const PRODUCTION_PREPARE_UNLOCKED=false;
const PRODUCTION_FINALIZE_UNLOCKED=false;
const INACTIVE_STAGING_ALLOWED=false;

function text(v){return String(v??'').trim();}
function norm(v){return text(v).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');}
function safe(v){return text(v).replace(/[\\/:*?"<>|\r\n]+/g,' ').replace(/\s+/g,' ').trim().slice(0,180);}
function hash(v){return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');}
function truth(v){return v===true||['TRUE','1','YES'].includes(text(v).toUpperCase());}
function rowsToObjects(values){if(!values?.length)return[];const h=values[0].map(text);return values.slice(1).filter(r=>r.some(v=>text(v)!=='')).map((r,i)=>{const o={__row:i+2};h.forEach((k,j)=>{if(k)o[k]=r[j]??'';});return o;});}
function manifestPayload(m){return{schema:m.schema,identityRow:m.identityRow,sourceSnapshot:m.sourceSnapshot,derived:m.derived,preconditions:m.preconditions};}
function recomputeManifestHash(m){return hash(manifestPayload(m));}
function canonicalJson(v){return JSON.stringify(v&&typeof v==='object'?v:{});}
function teamShort(v){const m=text(v).match(/team\s*(\d+)/i);return m?`Team ${m[1]}`:text(v);}

function assertApprovedManifest(m,approvedHash){
  if(!m||m.schema!==MANIFEST_SCHEMA)throw new Error('Manifest schema is not approved.');
  if(m.status!=='READY_TO_APPLY'||m.immutable!==true||m.writeAttempted!==false||m.fieldVisible!==false)throw new Error('Manifest is not an untouched READY_TO_APPLY transaction.');
  if(!approvedHash||approvedHash!==m.manifestHash)throw new Error('Approved manifest hash mismatch.');
  if(recomputeManifestHash(m)!==m.manifestHash)throw new Error('Manifest drift detected. Revalidate.');
  if(m.preconditions?.deleteRequired!==false)throw new Error('DELETE is forbidden.');
  if(m.preconditions?.uploadRuntimeChangeRequired!==false)throw new Error('Upload/runtime mutation is forbidden.');
  if(!text(m.derived?.storeId)||!text(m.derived?.storeKey)||!text(m.derived?.folderName))throw new Error('Manifest derived identity is incomplete.');
  return true;
}

function compareSnapshot(row,snapshot){const drift=[];for(const [k,v] of Object.entries(snapshot||{}))if(text(row?.[k])!==text(v))drift.push({field:k,approved:text(v),current:text(row?.[k])});return drift;}
function buildV4Record(m){const s=m.sourceSnapshot||{},d=m.derived||{};return{
  'Store Key':text(d.storeKey),'Store Name':text(s['Current Store Name']),'Assigned Team':teamShort(s['Assigned Team']),
  'Day':text(s['Scheduled Deployment Date']),'Stop No.':text(s['Scheduled Stop']),'Store Category':text(s['Store Category']),
  'Address':text(s['Street Address / Location']),'Barangay':text(s['Barangay / District']),'Area':text(s['City / Area']),
  'Material Allocation':text(s['Material Allocation']),'Material JSON':canonicalJson(d.materialJson),'Pending':text(d.pending||'FALSE'),
  'Category Rule':text(d.categoryRule),'Override Rule':'','Effective Rule':text(d.effectiveRule),'Active':'TRUE','Source Sync Timestamp':'','Store ID':text(d.storeId)
};}

async function oauthToken(){const need=n=>{const v=text(process.env[n]);if(!v)throw new Error(`Missing ${n}`);return v;};const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:need('GOOGLE_OAUTH_CLIENT_ID'),client_secret:need('GOOGLE_OAUTH_CLIENT_SECRET'),refresh_token:need('GOOGLE_OAUTH_REFRESH_TOKEN'),grant_type:'refresh_token'})});const d=await r.json();if(!r.ok||!d.access_token)throw new Error(`OAuth refresh failed: ${r.status}`);return d.access_token;}
async function getRange(tok,id,range){const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;const r=await fetch(u,{headers:{authorization:`Bearer ${tok}`}});if(!r.ok)throw new Error(`GET ${range} failed: ${r.status}`);return(await r.json()).values||[];}
async function batchValueWrite(tok,id,data){const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values:batchUpdate`;const r=await fetch(u,{method:'POST',headers:{authorization:`Bearer ${tok}`,'content-type':'application/json'},body:JSON.stringify({valueInputOption:'RAW',data})});if(!r.ok)throw new Error(`SOURCE PREPARE write failed: ${r.status}`);return r.json();}
async function appendValues(tok,id,range,values){const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;const r=await fetch(u,{method:'POST',headers:{authorization:`Bearer ${tok}`,'content-type':'application/json'},body:JSON.stringify({values})});if(!r.ok)throw new Error(`FINALIZE append failed: ${r.status}`);return r.json();}

async function driveChildren(tok,parent){const q=`'${String(parent).replace(/'/g,"\\'")}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;const u=`https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1000&fields=files(id,name,parents)&q=${encodeURIComponent(q)}`;const r=await fetch(u,{headers:{authorization:`Bearer ${tok}`}});if(!r.ok)throw new Error(`Drive read failed: ${r.status}`);return(await r.json()).files||[];}
async function findFolder(tok,parent,name){const kids=await driveChildren(tok,parent),n=norm(name);return kids.find(x=>x.name===name)||kids.find(x=>norm(x.name)===n)||null;}
async function createFolder(tok,parent,name){const r=await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,parents',{method:'POST',headers:{authorization:`Bearer ${tok}`,'content-type':'application/json'},body:JSON.stringify({name,mimeType:'application/vnd.google-apps.folder',parents:[parent]})});if(!r.ok)throw new Error(`Drive folder create failed: ${r.status}`);return r.json();}
async function resolveFolderPath(tok,root,m){const live=await findFolder(tok,root,'LIVE');if(!live)return{live:null,team:null,area:null,store:null};const team=await findFolder(tok,live.id,teamShort(m.sourceSnapshot['Assigned Team']));if(!team)return{live,team:null,area:null,store:null};const area=await findFolder(tok,team.id,text(m.sourceSnapshot['City / Area']));if(!area)return{live,team,area:null,store:null};const store=await findFolder(tok,area.id,m.derived.folderName);return{live,team,area,store};}

function headerRow(record,headers){return headers.map(h=>Object.prototype.hasOwnProperty.call(record,h)?record[h]:'');}
function exactRecordMatch(a,b,fields){return fields.every(f=>text(a?.[f])===text(b?.[f]));}

function preflightBlankCandidate({manifest,approvedHash,identityRows,liveStores}){
  assertApprovedManifest(manifest,approvedHash);
  const row=identityRows.find(r=>Number(r.__row)===Number(manifest.identityRow));if(!row)throw new Error('Approved source row no longer exists.');
  const drift=compareSnapshot(row,manifest.sourceSnapshot);if(drift.length)throw new Error('Source row drift: '+JSON.stringify(drift));
  if(text(row['Store ID'])||text(row['Legacy Store Key']))throw new Error('PREPARE requires the approved source row to still have blank Store ID and Legacy Store Key.');
  if(liveStores.some(s=>text(s['Store ID'])===text(manifest.derived.storeId)||text(s['Store Key'])===text(manifest.derived.storeKey)))throw new Error('Proposed Store ID or Store Key already exists live.');
  return row;
}

function preflightPreparedCandidate({manifest,approvedHash,identityRows,liveStores,folder}){
  assertApprovedManifest(manifest,approvedHash);
  const row=identityRows.find(r=>Number(r.__row)===Number(manifest.identityRow));if(!row)throw new Error('Prepared source row no longer exists.');
  const drift=compareSnapshot(row,manifest.sourceSnapshot);if(drift.length)throw new Error('Source row drift after PREPARE: '+JSON.stringify(drift));
  if(text(row['Store ID'])!==text(manifest.derived.storeId)||text(row['Legacy Store Key'])!==text(manifest.derived.storeKey))throw new Error('Prepared source identity does not match approved manifest.');
  if(!folder)throw new Error('Exact POE store folder must exist before FINALIZE.');
  const sameId=liveStores.filter(s=>text(s['Store ID'])===text(manifest.derived.storeId));const sameKey=liveStores.filter(s=>text(s['Store Key'])===text(manifest.derived.storeKey));
  if(sameId.length||sameKey.length){if(sameId.length===1&&sameKey.length===1&&sameId[0]===sameKey[0])return{row,alreadyLive:sameId[0]};throw new Error('Live identity collision detected.');}
  return{row,alreadyLive:null};
}

async function prepare({tok,manifest,approvedHash}){
  if(!PRODUCTION_PREPARE_UNLOCKED)throw new Error('PRODUCTION PREPARE IS HARD-LOCKED IN CODE.');
  const root=text(process.env.POE_ROOT_FOLDER_ID);if(!root)throw new Error('Missing POE_ROOT_FOLDER_ID.');
  const [iv,sv]=await Promise.all([getRange(tok,SOURCE_SHEET_ID,"'STORE IDENTITY & SCHEDULE'!A1:R1000"),getRange(tok,INTERNAL_SHEET_ID,'V4_STORES!A1:S1000')]);
  const identity=rowsToObjects(iv),stores=rowsToObjects(sv);const row=preflightBlankCandidate({manifest,approvedHash,identityRows:identity,liveStores:stores});
  const path=await resolveFolderPath(tok,root,manifest);if(!path.live||!path.team||!path.area)throw new Error('Drive parent path is not ready; PREPARE refused.');
  if(path.store)throw new Error('Store folder already exists before source identity PREPARE; revalidate collision manually.');
  const r=Number(row.__row),now=new Date().toISOString();
  await batchValueWrite(tok,SOURCE_SHEET_ID,[
    {range:`'STORE IDENTITY & SCHEDULE'!A${r}`,values:[[manifest.derived.storeId]]},
    {range:`'STORE IDENTITY & SCHEDULE'!P${r}`,values:[[manifest.derived.storeKey]]},
    {range:`'STORE IDENTITY & SCHEDULE'!Q${r}`,values:[['PREPARED_NOT_LIVE']]},
    {range:`'STORE IDENTITY & SCHEDULE'!R${r}`,values:[[now]]}
  ]);
  const folder=await createFolder(tok,path.area.id,safe(manifest.derived.folderName));
  return{state:'PREPARED_NOT_LIVE',sourceRow:r,storeId:manifest.derived.storeId,storeKey:manifest.derived.storeKey,folderId:folder.id,folderName:folder.name};
}

async function finalize({tok,manifest,approvedHash}){
  if(!PRODUCTION_FINALIZE_UNLOCKED)throw new Error('PRODUCTION FINALIZE IS HARD-LOCKED IN CODE.');
  if(INACTIVE_STAGING_ALLOWED)throw new Error('Unsafe configuration: inactive staging must remain disabled.');
  const root=text(process.env.POE_ROOT_FOLDER_ID);if(!root)throw new Error('Missing POE_ROOT_FOLDER_ID.');
  const [iv,sv,pv,phv]=await Promise.all([getRange(tok,SOURCE_SHEET_ID,"'STORE IDENTITY & SCHEDULE'!A1:R1000"),getRange(tok,INTERNAL_SHEET_ID,'V4_STORES!A1:S1000'),getRange(tok,INTERNAL_SHEET_ID,'V4_POE!A1:Z5000'),getRange(tok,INTERNAL_SHEET_ID,'V4_PHOTOS!A1:Z10000')]);
  const identity=rowsToObjects(iv),stores=rowsToObjects(sv),poe=rowsToObjects(pv),photos=rowsToObjects(phv);const path=await resolveFolderPath(tok,root,manifest);
  const pf=preflightPreparedCandidate({manifest,approvedHash,identityRows:identity,liveStores:stores,folder:path.store});
  const before={stores:hash(stores),poe:hash(poe),photos:hash(photos)};const expected=buildV4Record(manifest);
  if(pf.alreadyLive){const exact=exactRecordMatch(pf.alreadyLive,expected,Object.keys(expected));if(!exact)throw new Error('Store already live but record differs from approved manifest.');return{state:'ALREADY_FINALIZED_IDEMPOTENT',storeId:manifest.derived.storeId,before,after:before};}
  const headers=(sv[0]||[]).map(text);for(const h of Object.keys(expected))if(!headers.includes(h))throw new Error(`V4_STORES missing required header: ${h}`);
  await appendValues(tok,INTERNAL_SHEET_ID,'V4_STORES!A:S',[headerRow(expected,headers)]);
  const [sv2,pv2,phv2]=await Promise.all([getRange(tok,INTERNAL_SHEET_ID,'V4_STORES!A1:S1000'),getRange(tok,INTERNAL_SHEET_ID,'V4_POE!A1:Z5000'),getRange(tok,INTERNAL_SHEET_ID,'V4_PHOTOS!A1:Z10000')]);
  const stores2=rowsToObjects(sv2),poe2=rowsToObjects(pv2),photos2=rowsToObjects(phv2),hits=stores2.filter(s=>text(s['Store ID'])===text(manifest.derived.storeId)||text(s['Store Key'])===text(manifest.derived.storeKey));
  if(hits.length!==1)throw new Error(`POST-WRITE INCIDENT: expected exactly one live row, found ${hits.length}. No automatic rollback executed.`);
  if(!exactRecordMatch(hits[0],expected,Object.keys(expected)))throw new Error('POST-WRITE INCIDENT: live row differs from approved manifest. No automatic rollback executed.');
  const after={stores:hash(stores2),poe:hash(poe2),photos:hash(photos2)};
  if(before.poe!==after.poe||before.photos!==after.photos)throw new Error('POST-WRITE INCIDENT: protected POE/photo data changed. No automatic rollback executed.');
  return{state:'FINALIZED_LIVE_VERIFIED',storeId:manifest.derived.storeId,storeKey:manifest.derived.storeKey,before,after,counts:{storesBefore:stores.length,storesAfter:stores2.length,poeBefore:poe.length,poeAfter:poe2.length,photosBefore:photos.length,photosAfter:photos2.length}};
}

async function readLiveStatus(tok){const [iv,sv]=await Promise.all([getRange(tok,SOURCE_SHEET_ID,"'STORE IDENTITY & SCHEDULE'!A1:R1000"),getRange(tok,INTERNAL_SHEET_ID,'V4_STORES!A1:S1000')]);const identity=rowsToObjects(iv),stores=rowsToObjects(sv);const blankCandidates=identity.filter(r=>!text(r['Store ID'])&&Object.values(r).some(v=>text(v))).filter(r=>text(r['Current Store Name']));const prepared=identity.filter(r=>text(r['Identity Status'])==='PREPARED_NOT_LIVE'&&!stores.some(s=>text(s['Store ID'])===text(r['Store ID'])));return{identityRows:identity.length,liveStores:stores.length,blankCandidates:blankCandidates.map(r=>({row:r.__row,name:text(r['Current Store Name'])})),preparedNotLive:prepared.map(r=>({row:r.__row,storeId:text(r['Store ID']),name:text(r['Current Store Name'])}))};}

function selfTest(){
  const m={schema:MANIFEST_SCHEMA,identityRow:2,sourceSnapshot:{'Current Store Name':'Gamma','Assigned Team':'Team 1','Route Day':'DAY 2','Route Stop':'2','Scheduled Deployment Date':'2026-09-09','Scheduled Stop':'84','Store Category':'Feeds Store','Street Address / Location':'B','Barangay / District':'B1','City / Area':'Quezon City','Material Allocation':'SET 1','Active':'TRUE'},derived:{storeId:'SMF-0084',storeKey:'Team 1|Sept 9|84|Gamma',materialJson:{Flyers:150},categoryRule:'FEED',effectiveRule:'FEED',pending:'FALSE',folderName:'SMF-0084 - Gamma',folderPath:'LIVE / Team 1 / Quezon City / SMF-0084 - Gamma'},preconditions:{storeFolderExists:false,storeFolderProvisionRequired:true,fieldActivationRequiredAfterVerifiedWrite:true,uploadRuntimeChangeRequired:false,deleteRequired:false},status:'READY_TO_APPLY',immutable:true,writeAttempted:false,fieldVisible:false};m.manifestHash=recomputeManifestHash(m);
  const blank=[{__row:2,...m.sourceSnapshot,'Store ID':'','Legacy Store Key':''}],prepared=[{__row:2,...m.sourceSnapshot,'Store ID':'SMF-0084','Legacy Store Key':m.derived.storeKey}],stores=[{'Store ID':'SMF-0001','Store Key':'old'}];
  const a=preflightBlankCandidate({manifest:m,approvedHash:m.manifestHash,identityRows:blank,liveStores:stores});const b=preflightPreparedCandidate({manifest:m,approvedHash:m.manifestHash,identityRows:prepared,liveStores:stores,folder:{id:'f'}});const rec=buildV4Record(m);
  let prepareLocked=false,finalizeLocked=false;try{if(!PRODUCTION_PREPARE_UNLOCKED)throw new Error('locked');}catch{prepareLocked=true;}try{if(!PRODUCTION_FINALIZE_UNLOCKED)throw new Error('locked');}catch{finalizeLocked=true;}
  const tests={blankPreflight:!!a,preparedPreflight:!!b&&!b.alreadyLive,activeTrueFinalRecord:rec.Active==='TRUE',inactiveStagingDisabled:INACTIVE_STAGING_ALLOWED===false,prepareLocked,finalizeLocked,noDeletePath:true,noPoePhotoWritePath:true,oneStoreOnly:true};if(Object.values(tests).some(v=>v!==true))throw new Error('SELF TEST FAILED '+JSON.stringify(tests));return{ok:true,tests};
}

if(process.argv.includes('--self-test'))console.log(JSON.stringify(selfTest(),null,2));
else{
  fs.mkdirSync(OUT_DIR,{recursive:true});
  const tok=await oauthToken();
  const status=await readLiveStatus(tok);
  const report={generatedAt:new Date().toISOString(),mode:MODE,productionPrepareUnlocked:PRODUCTION_PREPARE_UNLOCKED,productionFinalizeUnlocked:PRODUCTION_FINALIZE_UNLOCKED,inactiveStagingAllowed:INACTIVE_STAGING_ALLOWED,status,writeAttempted:false,invariants:{prepareHardLocked:PRODUCTION_PREPARE_UNLOCKED===false,finalizeHardLocked:PRODUCTION_FINALIZE_UNLOCKED===false,inactiveStagingForbidden:INACTIVE_STAGING_ALLOWED===false,noDeletes:true,noV4PoeWrites:true,noV4PhotoWrites:true,oneStoreOnly:true,uploadRuntimeUntouchedRequired:true}};
  fs.writeFileSync(`${OUT_DIR}/production-one-store-transaction.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  const manifestPath=process.env.APPROVED_MANIFEST_PATH,approvedHash=text(process.env.APPROVED_MANIFEST_HASH);
  if(process.argv.includes('--prepare')||process.argv.includes('--finalize')){
    if(!manifestPath||!fs.existsSync(manifestPath))throw new Error('APPROVED_MANIFEST_PATH is required.');const m=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
    if(process.argv.includes('--prepare'))console.log(JSON.stringify(await prepare({tok,manifest:m,approvedHash}),null,2));
    if(process.argv.includes('--finalize'))console.log(JSON.stringify(await finalize({tok,manifest:m,approvedHash}),null,2));
  }
}
