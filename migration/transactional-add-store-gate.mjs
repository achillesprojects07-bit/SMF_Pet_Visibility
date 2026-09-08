#!/usr/bin/env node

/**
 * Transactional Add Store Gate — READ ONLY / FAIL CLOSED.
 *
 * Converts complete blank-ID source rows into immutable READY_TO_APPLY manifests.
 * It NEVER writes Sheets or Drive and NEVER activates a Field store.
 *
 * Safety model:
 * - existing Store IDs / Store Keys are never mutated
 * - new Store ID + compatibility Store Key are derived deterministically
 * - material JSON and category/effective rules must be proven from live data
 * - Drive LIVE / Team / Area must exist; store folder may be absent but must be provisionable
 * - manifest hash binds the exact source row + derived values + live/source fingerprints
 * - any later source/data drift makes the manifest stale and requires re-validation
 * - production write implementation remains disabled
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const SOURCE_SHEET_ID=process.env.SOURCE_SHEET_ID||'1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
const INTERNAL_SHEET_ID=process.env.GOOGLE_SHEET_ID||'1TNrb3ir8vS6CyZ8kXhRH43JXoH4Ws7iQ4g3649KQTf0';
const OUT_DIR=process.env.TRANSACTION_GATE_OUT_DIR||'migration/transaction-gate-output';
const MODE='READ_ONLY_TRANSACTION_GATE';
const writeImplementationEnabled=false;
const fieldActivationEnabled=false;

const REQUIRED=['Current Store Name','Assigned Team','Route Day','Route Stop','Scheduled Deployment Date','Scheduled Stop','Store Category','Street Address / Location','Barangay / District','City / Area','Material Allocation','Active'];
const MANIFEST_SCHEMA='SMF_ADD_STORE_MANIFEST_V1';

function text(v){return String(v??'').trim();}
function norm(v){return text(v).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[–—]/g,'-').replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');}
function safe(v){return text(v).replace(/[\\/:*?"<>|\r\n]+/g,' ').replace(/\s+/g,' ').trim().slice(0,180);}
function rowsToObjects(values){if(!values?.length)return[];const h=values[0].map(text);return values.slice(1).filter(r=>r.some(v=>text(v)!=='')).map((r,i)=>{const o={__row:i+2};h.forEach((k,j)=>{if(k)o[k]=r[j]??'';});return o;});}
function hash(v){return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');}
function teamShort(v){const m=text(v).match(/team\s*(\d+)/i);return m?`Team ${m[1]}`:text(v);}
function keyDateLabel(iso){const m=text(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return text(iso);const names={1:'Jan',2:'Feb',3:'Mar',4:'Apr',5:'May',6:'Jun',7:'Jul',8:'Aug',9:'Sept',10:'Oct',11:'Nov',12:'Dec'};return `${names[Number(m[2])]||m[2]} ${Number(m[3])}`;}
function keyFor(r,id){return `${teamShort(r['Assigned Team'])}|${keyDateLabel(r['Scheduled Deployment Date'])}|${text(r['Scheduled Stop'])}|${text(r['Current Store Name'])}`;}
function nextIds(identity,stores,count){const nums=[...identity,...stores].map(r=>text(r['Store ID'])).map(id=>{const m=id.match(/^SMF-(\d{4})$/);return m?Number(m[1]):0;});let n=Math.max(0,...nums)+1;return Array.from({length:count},()=>`SMF-${String(n++).padStart(4,'0')}`);}
function canonicalObject(o){return Object.fromEntries(Object.entries(o).filter(([,v])=>Number(v)!==0).sort(([a],[b])=>a.localeCompare(b)));}
function parseMaterialDefinitions(values){const headers=(values[3]||[]).map(text), rename={Banner:'Horizontal Banner'}, out=new Map();for(const row of values.slice(4)){const set=text(row[0]);if(!set||set==='PENDING')continue;const o={};for(let i=1;i<headers.length;i++){const h=rename[headers[i]]||headers[i];if(!h||h==='Notes')continue;const n=Number(row[i]??0);if(Number.isFinite(n)&&n!==0)o[h]=n;}out.set(set,canonicalObject(o));}return out;}
function deriveRules(stores){const m=new Map();for(const s of stores){const alloc=text(s['Material Allocation']);if(!alloc||/pending/i.test(alloc))continue;const k=`${norm(s['Store Category'])}|${norm(alloc)}`;if(!m.has(k))m.set(k,{categoryRules:new Set(),effectiveRules:new Set(),pending:new Set()});const b=m.get(k);b.categoryRules.add(text(s['Category Rule']));b.effectiveRules.add(text(s['Effective Rule']));b.pending.add(text(s.Pending).toUpperCase());}return m;}
function duplicateRisk(r,stores,candidates){const n=norm(r['Current Store Name']),a=norm(r['Street Address / Location']),t=teamShort(r['Assigned Team']);return [...stores.map(s=>({id:text(s['Store ID']),name:norm(s['Store Name']),address:norm(s.Address),team:teamShort(s['Assigned Team'])})),...candidates.map(c=>({id:c.storeId,name:norm(c.source['Current Store Name']),address:norm(c.source['Street Address / Location']),team:teamShort(c.source['Assigned Team'])}))].filter(x=>(n&&x.name===n)||(a&&x.address===a&&x.team===t));}

async function token(){const need=n=>{const v=text(process.env[n]);if(!v)throw new Error(`Missing ${n}`);return v;};const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:need('GOOGLE_OAUTH_CLIENT_ID'),client_secret:need('GOOGLE_OAUTH_CLIENT_SECRET'),refresh_token:need('GOOGLE_OAUTH_REFRESH_TOKEN'),grant_type:'refresh_token'})});const d=await r.json();if(!r.ok||!d.access_token)throw new Error(`OAuth refresh failed: ${r.status}`);return d.access_token;}
async function getRange(tok,id,range){const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;const r=await fetch(u,{headers:{authorization:`Bearer ${tok}`}});if(!r.ok)throw new Error(`GET ${range} failed: ${r.status}`);return(await r.json()).values||[];}
async function children(tok,parent){const q=`'${String(parent).replace(/'/g,"\\'")}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;const u=`https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1000&fields=files(id,name)&q=${encodeURIComponent(q)}`;const r=await fetch(u,{headers:{authorization:`Bearer ${tok}`}});if(!r.ok)throw new Error(`Drive read failed: ${r.status}`);return(await r.json()).files||[];}
async function folder(tok,parent,name){const kids=await children(tok,parent),n=norm(name);return kids.find(x=>x.name===name)||kids.find(x=>norm(x.name)===n)||null;}

async function buildGate({identity,stores,materialValues,driveResolver}){
  const defs=parseMaterialDefinitions(materialValues), rules=deriveRules(stores);
  const blankRows=identity.filter(r=>!text(r['Store ID']));
  const ids=nextIds(identity,stores,blankRows.length);
  const manifests=[],blocked=[],accepted=[];
  const usedIds=new Set(stores.map(s=>text(s['Store ID'])).filter(Boolean));
  const usedKeys=new Set(stores.map(s=>text(s['Store Key'])).filter(Boolean));
  for(let i=0;i<blankRows.length;i++){
    const r=blankRows[i], proposedId=ids[i], missing=REQUIRED.filter(f=>!text(r[f]));
    if(text(r['Legacy Store Key'])){blocked.push({identityRow:r.__row,reason:'NEW_ROW_MUST_HAVE_BLANK_LEGACY_KEY'});continue;}
    if(missing.length){blocked.push({identityRow:r.__row,reason:'REQUIRED_FIELDS_MISSING',missing});continue;}
    const risk=duplicateRisk(r,stores,accepted);if(risk.length){blocked.push({identityRow:r.__row,reason:'POSSIBLE_DUPLICATE_STORE',risk});continue;}
    if(usedIds.has(proposedId)){blocked.push({identityRow:r.__row,reason:'PROPOSED_STORE_ID_COLLISION',proposedId});continue;}
    const storeKey=keyFor(r,proposedId);if(usedKeys.has(storeKey)){blocked.push({identityRow:r.__row,reason:'PROPOSED_STORE_KEY_COLLISION',storeKey});continue;}
    const allocation=text(r['Material Allocation']);const materialJson=defs.get(allocation);if(!materialJson){blocked.push({identityRow:r.__row,reason:'MATERIAL_ALLOCATION_NOT_PROVEN',allocation});continue;}
    const rb=rules.get(`${norm(r['Store Category'])}|${norm(allocation)}`);const categoryRules=rb?[...rb.categoryRules].filter(Boolean):[],effectiveRules=rb?[...rb.effectiveRules].filter(Boolean):[],pending=rb?[...rb.pending].filter(Boolean):[];
    if(!rb||categoryRules.length!==1||effectiveRules.length!==1||pending.length!==1){blocked.push({identityRow:r.__row,reason:'CATEGORY_RULE_NOT_UNAMBIGUOUS',category:text(r['Store Category']),allocation});continue;}
    const drive=await driveResolver(r,proposedId);if(!drive.liveExists||!drive.teamExists||!drive.areaExists){blocked.push({identityRow:r.__row,reason:'DRIVE_PARENT_PATH_NOT_READY',drive});continue;}
    if(drive.storeCollision){blocked.push({identityRow:r.__row,reason:'STORE_FOLDER_COLLISION',drive});continue;}
    const sourceSnapshot=Object.fromEntries(REQUIRED.map(f=>[f,text(r[f])]));
    const derived={storeId:proposedId,storeKey,materialJson,categoryRule:categoryRules[0],effectiveRule:effectiveRules[0],pending:pending[0],folderName:`${safe(proposedId)} - ${safe(r['Current Store Name'])}`,folderPath:`LIVE / ${safe(teamShort(r['Assigned Team']))} / ${safe(r['City / Area'])} / ${safe(proposedId)} - ${safe(r['Current Store Name'])}`};
    const payload={schema:MANIFEST_SCHEMA,identityRow:r.__row,sourceSnapshot,derived,preconditions:{storeFolderExists:drive.storeExists,storeFolderProvisionRequired:!drive.storeExists,fieldActivationRequiredAfterVerifiedWrite:true,uploadRuntimeChangeRequired:false,deleteRequired:false}};
    const manifestHash=hash(payload);
    const manifest={...payload,status:'READY_TO_APPLY',manifestHash,immutable:true,writeAttempted:false,fieldVisible:false};
    manifests.push(manifest);accepted.push({storeId:proposedId,source:r});usedIds.add(proposedId);usedKeys.add(storeKey);
  }
  return {manifests,blocked,candidateCount:blankRows.length};
}

function selfTest(){
  const material=[['x'],['x'],['x'],['Set','Flyers','Posters','Available Here','Banner','Shirt','Notes'],['SET 1','150','30','6','4','6','x']];
  const stores=[{'Store ID':'SMF-0001','Store Key':'Team 1|Sept 2|1|Alpha','Store Name':'Alpha','Assigned Team':'Team 1','Store Category':'Feeds Store','Address':'A','Area':'Quezon City','Material Allocation':'SET 1','Category Rule':'FEED','Effective Rule':'FEED','Pending':'FALSE'}];
  const row={__row:2,'Store ID':'','Legacy Store Key':'','Current Store Name':'Gamma','Assigned Team':'Team 1','Route Day':'DAY 2','Route Stop':'2','Scheduled Deployment Date':'2026-09-09','Scheduled Stop':'2','Store Category':'Feeds Store','Street Address / Location':'B','Barangay / District':'B1','City / Area':'Quezon City','Material Allocation':'SET 1','Active':'TRUE'};
  return buildGate({identity:[row],stores,materialValues:material,driveResolver:async()=>({liveExists:true,teamExists:true,areaExists:true,storeExists:false,storeCollision:false})}).then(r=>{const m=r.manifests[0];const changed=JSON.parse(JSON.stringify(m));changed.sourceSnapshot['Current Store Name']='Changed';const stale=hash({schema:changed.schema,identityRow:changed.identityRow,sourceSnapshot:changed.sourceSnapshot,derived:changed.derived,preconditions:changed.preconditions})!==m.manifestHash;const tests={oneReady:r.manifests.length===1&&r.blocked.length===0,id:m.derived.storeId==='SMF-0002',fieldHidden:m.fieldVisible===false,noWrite:m.writeAttempted===false,folderProvisionSeparated:m.preconditions.storeFolderProvisionRequired===true,immutableHash:stale===true};if(Object.values(tests).some(v=>v!==true))throw new Error('SELF TEST FAILED '+JSON.stringify(tests));return {ok:true,tests};});
}

if(process.argv.includes('--self-test')){console.log(JSON.stringify(await selfTest(),null,2));}
else{
  const tok=await token();
  const [iv,mv,sv]=await Promise.all([getRange(tok,SOURCE_SHEET_ID,"'STORE IDENTITY & SCHEDULE'!A1:R1000"),getRange(tok,SOURCE_SHEET_ID,"'MATERIAL SET DEFINITIONS'!A1:P50"),getRange(tok,INTERNAL_SHEET_ID,'V4_STORES!A1:S1000')]);
  const identity=rowsToObjects(iv),stores=rowsToObjects(sv),root=text(process.env.POE_ROOT_FOLDER_ID);
  const driveResolver=async(r,id)=>{if(!root)return{liveExists:false,teamExists:false,areaExists:false,storeExists:false,storeCollision:false};const live=await folder(tok,root,'LIVE');if(!live)return{liveExists:false,teamExists:false,areaExists:false,storeExists:false,storeCollision:false};const team=await folder(tok,live.id,teamShort(r['Assigned Team']));if(!team)return{liveExists:true,teamExists:false,areaExists:false,storeExists:false,storeCollision:false};const area=await folder(tok,team.id,text(r['City / Area']));if(!area)return{liveExists:true,teamExists:true,areaExists:false,storeExists:false,storeCollision:false};const kids=await children(tok,area.id),expected=`${safe(id)} - ${safe(r['Current Store Name'])}`,n=norm(expected),nn=norm(r['Current Store Name']),ni=norm(id);const exact=kids.find(k=>norm(k.name)===n)||null;const collision=kids.find(k=>{const nk=norm(k.name);return nk===ni||nk===nn||(ni&&nk.includes(ni))||(nn&&nk===nn);})||null;return{liveExists:true,teamExists:true,areaExists:true,storeExists:!!exact,storeCollision:!!collision&&!exact,existingFolder:exact?.name||collision?.name||''};};
  const gate=await buildGate({identity,stores,materialValues:mv,driveResolver});
  const report={generatedAt:new Date().toISOString(),mode:MODE,writeImplementationEnabled,fieldActivationEnabled,candidateCount:gate.candidateCount,readyCount:gate.manifests.length,blockedCount:gate.blocked.length,manifests:gate.manifests,blocked:gate.blocked,globalFingerprints:{identity:hash(identity),liveStores:hash(stores),materials:hash(mv)},invariants:{noWrites:true,writeImplementationDisabled:writeImplementationEnabled===false,fieldActivationDisabled:fieldActivationEnabled===false,noDeletes:true,uploadRuntimeFilesUnchangedRequired:true,allCandidatesAccountedFor:gate.candidateCount===gate.manifests.length+gate.blocked.length,allReadyManifestsImmutable:gate.manifests.every(m=>m.immutable&&m.status==='READY_TO_APPLY'&&m.fieldVisible===false&&m.writeAttempted===false)}};
  fs.mkdirSync(OUT_DIR,{recursive:true});fs.writeFileSync(`${OUT_DIR}/transactional-add-store-gate.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({mode:MODE,writeImplementationEnabled,fieldActivationEnabled,candidateCount:report.candidateCount,readyCount:report.readyCount,blockedCount:report.blockedCount,invariants:report.invariants,manifestHashes:report.manifests.map(m=>m.manifestHash)},null,2));
  if(Object.values(report.invariants).some(v=>v!==true)||report.blockedCount>0)process.exitCode=2;
}
