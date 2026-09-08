#!/usr/bin/env node

/**
 * Production One-Store Dry Run — READ ONLY / ONE STORE / FAIL CLOSED.
 *
 * Step 2 safety proof for adding a future store. Uses current production data
 * to construct exactly one proof-only transaction manifest and simulates the
 * resulting V4_STORES/source identity state entirely in memory.
 *
 * NEVER writes Sheets or Drive. NEVER activates Field. NEVER touches uploader.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const SOURCE_SHEET_ID=process.env.SOURCE_SHEET_ID||'1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
const INTERNAL_SHEET_ID=process.env.GOOGLE_SHEET_ID||'1TNrb3ir8vS6CyZ8kXhRH43JXoH4Ws7iQ4g3649KQTf0';
const OUT_DIR=process.env.PROD_DRY_RUN_OUT_DIR||'migration/production-one-store-dry-run-output';
const MODE='PRODUCTION_DATA_ONE_STORE_DRY_RUN';
const MANIFEST_SCHEMA='SMF_ADD_STORE_MANIFEST_V1';
const PRODUCTION_WRITE_ENABLED=false;
const FIELD_ACTIVATION_ENABLED=false;
const PROOF_NAME='NEW STORE DRY RUN PROOF ONLY';

function text(v){return String(v??'').trim();}
function norm(v){return text(v).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');}
function safe(v){return text(v).replace(/[\\/:*?"<>|\r\n]+/g,' ').replace(/\s+/g,' ').trim().slice(0,180);}
function hash(v){return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');}
function rowsToObjects(values){if(!values?.length)return[];const h=values[0].map(text);return values.slice(1).filter(r=>r.some(v=>text(v)!=='')).map((r,i)=>{const o={__row:i+2};h.forEach((k,j)=>{if(k)o[k]=r[j]??'';});return o;});}
function teamShort(v){const m=text(v).match(/team\s*(\d+)/i);return m?`Team ${m[1]}`:text(v);}
function keyDateLabel(iso){const m=text(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return text(iso);const names={1:'Jan',2:'Feb',3:'Mar',4:'Apr',5:'May',6:'Jun',7:'Jul',8:'Aug',9:'Sept',10:'Oct',11:'Nov',12:'Dec'};return `${names[Number(m[2])]||m[2]} ${Number(m[3])}`;}
function nextStoreId(identity,stores){const nums=[...identity,...stores].map(r=>text(r['Store ID'])).map(id=>{const m=id.match(/^SMF-(\d{4})$/);return m?Number(m[1]):0;});return `SMF-${String(Math.max(0,...nums)+1).padStart(4,'0')}`;}
function canonical(o){return Object.fromEntries(Object.entries(o||{}).filter(([,v])=>Number(v)!==0).sort(([a],[b])=>a.localeCompare(b)));}
function parseDefs(values){const headers=(values[3]||[]).map(text),rename={Banner:'Horizontal Banner'},m=new Map();for(const row of values.slice(4)){const set=text(row[0]);if(!set||set==='PENDING')continue;const o={};for(let i=1;i<headers.length;i++){const h=rename[headers[i]]||headers[i];if(!h||h==='Notes')continue;const n=Number(row[i]??0);if(Number.isFinite(n)&&n!==0)o[h]=n;}m.set(set,canonical(o));}return m;}
function deriveRule(stores,category,allocation){const hits=stores.filter(s=>norm(s['Store Category'])===norm(category)&&norm(s['Material Allocation'])===norm(allocation));const cr=[...new Set(hits.map(s=>text(s['Category Rule'])).filter(Boolean))],er=[...new Set(hits.map(s=>text(s['Effective Rule'])).filter(Boolean))],p=[...new Set(hits.map(s=>text(s.Pending).toUpperCase()).filter(Boolean))];if(!hits.length||cr.length!==1||er.length!==1||p.length!==1)throw new Error('Rule derivation is not unambiguous.');return{categoryRule:cr[0],effectiveRule:er[0],pending:p[0]};}

async function token(){const need=n=>{const v=text(process.env[n]);if(!v)throw new Error(`Missing ${n}`);return v;};const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:need('GOOGLE_OAUTH_CLIENT_ID'),client_secret:need('GOOGLE_OAUTH_CLIENT_SECRET'),refresh_token:need('GOOGLE_OAUTH_REFRESH_TOKEN'),grant_type:'refresh_token'})});const d=await r.json();if(!r.ok||!d.access_token)throw new Error('OAuth refresh failed.');return d.access_token;}
async function getRange(tok,id,range){const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;const r=await fetch(u,{headers:{authorization:`Bearer ${tok}`}});if(!r.ok)throw new Error(`GET ${range} failed: ${r.status}`);return(await r.json()).values||[];}
async function children(tok,parent){const q=`'${String(parent).replace(/'/g,"\\'")}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;const u=`https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1000&fields=files(id,name)&q=${encodeURIComponent(q)}`;const r=await fetch(u,{headers:{authorization:`Bearer ${tok}`}});if(!r.ok)throw new Error(`Drive read failed: ${r.status}`);return(await r.json()).files||[];}
async function findFolder(tok,parent,name){const kids=await children(tok,parent),n=norm(name);return kids.find(x=>x.name===name)||kids.find(x=>norm(x.name)===n)||null;}

function manifestHashPayload(m){return{schema:m.schema,identityRow:m.identityRow,sourceSnapshot:m.sourceSnapshot,derived:m.derived,preconditions:m.preconditions};}
function buildManifest({identity,stores,defs,drive}){
  const id=nextStoreId(identity,stores);
  if(identity.some(r=>text(r['Store ID'])===id)||stores.some(r=>text(r['Store ID'])===id))throw new Error('Next Store ID is not unique.');
  const template=stores.find(s=>text(s['Material Allocation'])==='SET 1'&&text(s['Category Rule'])==='FEED'&&text(s['Effective Rule']))||stores[0];
  if(!template)throw new Error('No live template store available.');
  const allocation=text(template['Material Allocation']),materialJson=defs.get(allocation);if(!materialJson)throw new Error('Material definition not proven.');
  const rules=deriveRule(stores,text(template['Store Category']),allocation);
  const scheduledDate='2026-09-09',scheduledStop=String(Math.max(84,stores.length+1));
  const sourceSnapshot={'Current Store Name':PROOF_NAME,'Assigned Team':teamShort(template['Assigned Team']),'Route Day':'DAY 8','Route Stop':scheduledStop,'Scheduled Deployment Date':scheduledDate,'Scheduled Stop':scheduledStop,'Store Category':text(template['Store Category']),'Street Address / Location':'PROOF ONLY - NOT A REAL STORE','Barangay / District':'PROOF ONLY','City / Area':text(template.Area),'Material Allocation':allocation,'Active':'FALSE'};
  const storeKey=`${teamShort(sourceSnapshot['Assigned Team'])}|${keyDateLabel(scheduledDate)}|${scheduledStop}|${PROOF_NAME}`;
  if(stores.some(s=>text(s['Store Key'])===storeKey)||identity.some(s=>text(s['Legacy Store Key'])===storeKey))throw new Error('Proof Store Key collided with live data.');
  const folderName=`${safe(id)} - ${safe(PROOF_NAME)}`;
  const derived={storeId:id,storeKey,materialJson,categoryRule:rules.categoryRule,effectiveRule:rules.effectiveRule,pending:rules.pending,folderName,folderPath:`LIVE / ${safe(sourceSnapshot['Assigned Team'])} / ${safe(sourceSnapshot['City / Area'])} / ${folderName}`};
  const preconditions={storeFolderExists:drive.storeExists,storeFolderProvisionRequired:!drive.storeExists,fieldActivationRequiredAfterVerifiedWrite:true,uploadRuntimeChangeRequired:false,deleteRequired:false};
  const m={schema:MANIFEST_SCHEMA,identityRow:null,sourceSnapshot,derived,preconditions,status:'READY_TO_DRY_RUN',immutable:true,writeAttempted:false,fieldVisible:false,proofOnly:true};m.manifestHash=hash(manifestHashPayload(m));return m;
}

function simulate({manifest,stores,identity,poe,photos}){
  const v4Record={'Store Key':manifest.derived.storeKey,'Store Name':manifest.sourceSnapshot['Current Store Name'],'Assigned Team':manifest.sourceSnapshot['Assigned Team'],'Day':manifest.sourceSnapshot['Scheduled Deployment Date'],'Stop No.':manifest.sourceSnapshot['Scheduled Stop'],'Store Category':manifest.sourceSnapshot['Store Category'],'Address':manifest.sourceSnapshot['Street Address / Location'],'Barangay':manifest.sourceSnapshot['Barangay / District'],'Area':manifest.sourceSnapshot['City / Area'],'Material Allocation':manifest.sourceSnapshot['Material Allocation'],'Material JSON':JSON.stringify(manifest.derived.materialJson),'Pending':manifest.derived.pending,'Category Rule':manifest.derived.categoryRule,'Override Rule':'','Effective Rule':manifest.derived.effectiveRule,'Active':'FALSE','Source Sync Timestamp':'','Store ID':manifest.derived.storeId};
  const sourceRecord={'Store ID':manifest.derived.storeId,'Current Store Name':manifest.sourceSnapshot['Current Store Name'],'Assigned Team':manifest.sourceSnapshot['Assigned Team'],'Route Day':manifest.sourceSnapshot['Route Day'],'Route Stop':manifest.sourceSnapshot['Route Stop'],'Scheduled Deployment Date':manifest.sourceSnapshot['Scheduled Deployment Date'],'Scheduled Stop':manifest.sourceSnapshot['Scheduled Stop'],'Actual Visit Date':'','Store Category':manifest.sourceSnapshot['Store Category'],'Street Address / Location':manifest.sourceSnapshot['Street Address / Location'],'Barangay / District':manifest.sourceSnapshot['Barangay / District'],'City / Area':manifest.sourceSnapshot['City / Area'],'Material Allocation':manifest.sourceSnapshot['Material Allocation'],'Active':'FALSE','Legacy Store Key':manifest.derived.storeKey};
  const simulatedStores=[...stores,v4Record],simulatedIdentity=[...identity,sourceRecord];
  return{wouldWrite:{v4StoresAppend:[v4Record],sourceIdentityAppend:[sourceRecord],v4PoeWrites:[],v4PhotoWrites:[],driveWrites:[],deletes:[],fieldActivationWrites:[]},before:{stores:hash(stores),identity:hash(identity),poe:hash(poe),photos:hash(photos)},after:{stores:hash(simulatedStores),identity:hash(simulatedIdentity),poe:hash(poe),photos:hash(photos)},counts:{storesBefore:stores.length,storesAfter:simulatedStores.length,identityBefore:identity.length,identityAfter:simulatedIdentity.length,poeBefore:poe.length,poeAfter:poe.length,photosBefore:photos.length,photosAfter:photos.length}};
}

function selfTest(){const manifest={derived:{storeId:'SMF-0002',storeKey:'k',materialJson:{Flyers:1},pending:'FALSE',categoryRule:'FEED',effectiveRule:'FEED'},sourceSnapshot:{'Current Store Name':'Proof','Assigned Team':'Team 1','Scheduled Deployment Date':'2026-09-09','Scheduled Stop':'2','Route Day':'DAY 2','Route Stop':'2','Store Category':'Feeds Store','Street Address / Location':'x','Barangay / District':'x','City / Area':'x','Material Allocation':'SET 1'}};const s=simulate({manifest,stores:[{'Store ID':'SMF-0001'}],identity:[{'Store ID':'SMF-0001'}],poe:[{x:1}],photos:[{y:1}]});const tests={oneStore:s.wouldWrite.v4StoresAppend.length===1,oneIdentity:s.wouldWrite.sourceIdentityAppend.length===1,noPoe:s.wouldWrite.v4PoeWrites.length===0,noPhotos:s.wouldWrite.v4PhotoWrites.length===0,noDrive:s.wouldWrite.driveWrites.length===0,noDelete:s.wouldWrite.deletes.length===0,inactive:s.wouldWrite.v4StoresAppend[0].Active==='FALSE',poeFingerprintStable:s.before.poe===s.after.poe,photoFingerprintStable:s.before.photos===s.after.photos};if(Object.values(tests).some(v=>v!==true))throw new Error('SELF TEST FAILED '+JSON.stringify(tests));return{ok:true,tests};}

if(process.argv.includes('--self-test'))console.log(JSON.stringify(selfTest(),null,2));
else{
  const tok=await token();
  const [iv,mv,sv,pv,phv]=await Promise.all([getRange(tok,SOURCE_SHEET_ID,"'STORE IDENTITY & SCHEDULE'!A1:R1000"),getRange(tok,SOURCE_SHEET_ID,"'MATERIAL SET DEFINITIONS'!A1:P50"),getRange(tok,INTERNAL_SHEET_ID,'V4_STORES!A1:S1000'),getRange(tok,INTERNAL_SHEET_ID,'V4_POE!A1:Z5000'),getRange(tok,INTERNAL_SHEET_ID,'V4_PHOTOS!A1:Z10000')]);
  const identity=rowsToObjects(iv),stores=rowsToObjects(sv),poe=rowsToObjects(pv),photos=rowsToObjects(phv),defs=parseDefs(mv);
  const nextId=nextStoreId(identity,stores),template=stores.find(s=>text(s['Material Allocation'])==='SET 1'&&text(s['Category Rule'])==='FEED'&&text(s['Effective Rule']))||stores[0];
  const root=text(process.env.POE_ROOT_FOLDER_ID);let drive={checked:false,liveExists:false,teamExists:false,areaExists:false,storeExists:false};
  if(root&&template){const live=await findFolder(tok,root,'LIVE');drive.checked=true;drive.liveExists=!!live;if(live){const team=await findFolder(tok,live.id,teamShort(template['Assigned Team']));drive.teamExists=!!team;if(team){const area=await findFolder(tok,team.id,text(template.Area));drive.areaExists=!!area;if(area){const f=await findFolder(tok,area.id,`${safe(nextId)} - ${safe(PROOF_NAME)}`);drive.storeExists=!!f;}}}}
  const manifest=buildManifest({identity,stores,defs,drive}),sim=simulate({manifest,stores,identity,poe,photos});
  const blankIdCandidates=identity.filter(r=>!text(r['Store ID'])).length;
  const invariants={readOnly:true,productionWriteDisabled:PRODUCTION_WRITE_ENABLED===false,fieldActivationDisabled:FIELD_ACTIVATION_ENABLED===false,exactlyOneStoreScope:sim.wouldWrite.v4StoresAppend.length===1&&sim.wouldWrite.sourceIdentityAppend.length===1,noDeletes:sim.wouldWrite.deletes.length===0,noDriveWrites:sim.wouldWrite.driveWrites.length===0,noPoeWrites:sim.wouldWrite.v4PoeWrites.length===0,noPhotoWrites:sim.wouldWrite.v4PhotoWrites.length===0,noFieldActivationWrites:sim.wouldWrite.fieldActivationWrites.length===0,v4PoeUnchanged:sim.before.poe===sim.after.poe,v4PhotosUnchanged:sim.before.photos===sim.after.photos,storeCountDeltaExactlyOne:sim.counts.storesAfter===sim.counts.storesBefore+1,identityCountDeltaExactlyOne:sim.counts.identityAfter===sim.counts.identityBefore+1,nextIdStillUnique:!stores.some(s=>text(s['Store ID'])===manifest.derived.storeId)&&!identity.some(s=>text(s['Store ID'])===manifest.derived.storeId),storeKeyStillUnique:!stores.some(s=>text(s['Store Key'])===manifest.derived.storeKey)&&!identity.some(s=>text(s['Legacy Store Key'])===manifest.derived.storeKey),manifestImmutable:manifest.immutable===true&&manifest.writeAttempted===false&&manifest.fieldVisible===false,proofOnly:manifest.proofOnly===true,uploadRuntimeChangeRequired:manifest.preconditions.uploadRuntimeChangeRequired===false,deleteRequired:manifest.preconditions.deleteRequired===false};
  const report={generatedAt:new Date().toISOString(),mode:MODE,productionWriteEnabled:PRODUCTION_WRITE_ENABLED,fieldActivationEnabled:FIELD_ACTIVATION_ENABLED,blankIdCandidates,realStoreApplied:false,proofOnly:true,manifest,drive,simulation:sim,invariants,fingerprint:hash({manifestHash:manifest.manifestHash,before:sim.before,after:sim.after,counts:sim.counts})};
  fs.mkdirSync(OUT_DIR,{recursive:true});fs.writeFileSync(`${OUT_DIR}/production-one-store-dry-run.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({mode:MODE,blankIdCandidates,realStoreApplied:false,manifestHash:manifest.manifestHash,storeId:manifest.derived.storeId,storeKey:manifest.derived.storeKey,drive,counts:sim.counts,invariants,fingerprint:report.fingerprint},null,2));
  if(Object.values(invariants).some(v=>v!==true))process.exitCode=2;
}
