#!/usr/bin/env node

/**
 * Build / maintain the source workbook's STORE IDENTITY & SCHEDULE layer.
 *
 * Safety contract:
 * - reads source STORE MASTER + MATERIALS and live V4_STORES/V4_POE
 * - writes ONLY to source tab STORE IDENTITY & SCHEDULE
 * - MERGE_BY_STORE_ID: existing rows are merged by permanent Store ID, never rebuilt by position
 * - Store ID and Legacy Store Key are immutable
 * - management-editable fields are preserved exactly when an identity row already exists
 * - Actual Visit Date / Previous Name / Identity Status are system-maintained
 * - never writes V4_STORES, V4_POE, V4_PHOTOS, Apps Script, Cloudflare, or Drive files/folders
 * - never deletes rows or files
 * - aborts before writing unless all 83 baseline source stores resolve one-to-one to the 83 live Store IDs
 */

const SOURCE_SHEET_ID = process.env.SOURCE_SHEET_ID || '1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
const INTERNAL_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1TNrb3ir8vS6CyZ8kXhRH43JXoH4Ws7iQ4g3649KQTf0';
const TARGET_SHEET = 'STORE IDENTITY & SCHEDULE';
const EXPECTED_STORE_COUNT = 83;
const MERGE_POLICY = 'MERGE_BY_STORE_ID';

const HEADERS = ['Store ID','Current Store Name','Previous Name','Assigned Team','Route Day','Route Stop','Scheduled Deployment Date','Scheduled Stop','Actual Visit Date','Store Category','Street Address / Location','Barangay / District','City / Area','Material Allocation','Active','Legacy Store Key','Identity Status','Last Identity Sync'];
const MANAGEMENT_FIELDS = ['Current Store Name','Assigned Team','Route Day','Route Stop','Scheduled Deployment Date','Scheduled Stop','Store Category','Street Address / Location','Barangay / District','City / Area','Material Allocation','Active'];

function need(name){const v=String(process.env[name]||'').trim();if(!v)throw new Error(`Missing required environment variable: ${name}`);return v;}
function norm(v){return String(v??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');}
function teamNorm(v){const m=String(v??'').match(/team\s*(\d+)/i);return m?`Team ${m[1]}`:String(v??'').trim();}
function rowsToObjects(values){if(!values?.length)return[];const h=values[0].map(v=>String(v??'').trim());return values.slice(1).filter(r=>r.some(v=>String(v??'').trim()!=='' )).map((r,i)=>{const o={__row:i+2};h.forEach((k,j)=>{if(k)o[k]=r[j]??'';});return o;});}
function unique(arr){return new Set(arr).size===arr.length;}
function legacyNameFromKey(key){const p=String(key??'').split('|');return p.length>=4?p.slice(3).join('|').trim():'';}
function isoScheduled(v){const s=String(v||'').trim();const m=s.match(/^Sept\s+(\d{1,2})$/i);return m?`2026-09-${String(Number(m[1])).padStart(2,'0')}`:s;}
function dateOnly(v){const s=String(v||'').trim();if(!s)return'';let m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);if(m)return`${m[3]}-${String(Number(m[1])).padStart(2,'0')}-${String(Number(m[2])).padStart(2,'0')}`;m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);return m?`${m[1]}-${m[2]}-${m[3]}`:'';}
function dateRank(v){const d=dateOnly(v);return d?Date.parse(`${d}T00:00:00Z`):0;}
function text(v){return String(v??'').trim();}
function same(a,b){return text(a)===text(b);}
function mergeHistory(...values){const out=[];for(const raw of values){for(const part of String(raw??'').split(';')){const v=part.trim();if(v&&!out.some(x=>norm(x)===norm(v)))out.push(v);}}return out.join('; ');}
function rowArray(o){return HEADERS.map(h=>o[h]??'');}
function arraysEqual(a,b,count=17){for(let i=0;i<count;i++)if(text(a?.[i])!==text(b?.[i]))return false;return true;}

async function accessToken(){const body=new URLSearchParams({client_id:need('GOOGLE_OAUTH_CLIENT_ID'),client_secret:need('GOOGLE_OAUTH_CLIENT_SECRET'),refresh_token:need('GOOGLE_OAUTH_REFRESH_TOKEN'),grant_type:'refresh_token'});const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});const j=await r.json();if(!r.ok||!j.access_token)throw new Error(`Google OAuth refresh failed: ${r.status}`);return j.access_token;}
async function getRange(token,id,range){const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;const r=await fetch(u,{headers:{authorization:`Bearer ${token}`}});if(!r.ok)throw new Error(`GET ${range} failed: ${r.status} ${await r.text()}`);return(await r.json()).values||[];}
async function getSpreadsheet(token,id){const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}?fields=sheets.properties`;const r=await fetch(u,{headers:{authorization:`Bearer ${token}`}});if(!r.ok)throw new Error(`Spreadsheet metadata failed: ${r.status} ${await r.text()}`);return r.json();}
async function batchUpdate(token,id,requests){const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}:batchUpdate`;const r=await fetch(u,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({requests})});if(!r.ok)throw new Error(`batchUpdate failed: ${r.status} ${await r.text()}`);return r.json();}
async function putValues(token,id,range,values){const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;const r=await fetch(u,{method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({range,majorDimension:'ROWS',values})});if(!r.ok)throw new Error(`values.update failed: ${r.status} ${await r.text()}`);return r.json();}

function matchSource(src,live){const team=teamNorm(src['Assigned Team']);const name=norm(src['Store Name']);const addr=norm(src['Street Address / Location']);const sameTeam=live.filter(s=>teamNorm(s['Assigned Team'])===team);const byName=sameTeam.filter(s=>name&&(name===norm(s['Store Name'])||name===norm(legacyNameFromKey(s['Store Key']))));if(byName.length===1)return byName[0];if(byName.length>1)throw new Error(`Ambiguous name match: ${src['Store Name']}`);const byAddr=sameTeam.filter(s=>addr&&addr===norm(s['Address']));if(byAddr.length===1)return byAddr[0];if(byAddr.length>1)throw new Error(`Ambiguous address match: ${src['Store Name']}`);throw new Error(`No safe live Store ID match for source store: ${src['Store Name']}`);}

const token=await accessToken();
const [sourceValues,liveValues,poeValues,meta]=await Promise.all([
  getRange(token,SOURCE_SHEET_ID,"'STORE MASTER + MATERIALS'!A1:L500"),
  getRange(token,INTERNAL_SHEET_ID,'V4_STORES!A1:R500'),
  getRange(token,INTERNAL_SHEET_ID,'V4_POE!A1:S2000'),
  getSpreadsheet(token,SOURCE_SHEET_ID)
]);
const source=rowsToObjects(sourceValues);
const live=rowsToObjects(liveValues);
const poe=rowsToObjects(poeValues).filter(r=>String(r.Environment||'').toUpperCase()==='LIVE');
if(source.length!==EXPECTED_STORE_COUNT)throw new Error(`Source store count ${source.length}; expected ${EXPECTED_STORE_COUNT}. No write performed.`);
if(live.length!==EXPECTED_STORE_COUNT)throw new Error(`Live store count ${live.length}; expected ${EXPECTED_STORE_COUNT}. No write performed.`);
const ids=live.map(s=>text(s['Store ID']));const keys=live.map(s=>text(s['Store Key']));
if(ids.some(v=>!v)||!unique(ids))throw new Error('Live Store IDs are blank/duplicated. No write performed.');
if(keys.some(v=>!v)||!unique(keys))throw new Error('Live Store Keys are blank/duplicated. No write performed.');

const poeByKey=new Map();
for(const r of poe){const k=text(r['Store Key']);const completed=text(r['Completed At']);if(!k||!completed)continue;const prev=poeByKey.get(k);if(!prev||dateRank(completed)>dateRank(prev))poeByKey.set(k,completed);}

const bootstrapById=new Map();const matchedIds=new Set();
for(const src of source){const s=matchSource(src,live);const id=text(s['Store ID']);if(matchedIds.has(id))throw new Error(`Store ID matched more than once: ${id}. No write performed.`);matchedIds.add(id);const currentName=text(s['Store Name']);const sourceName=text(src['Store Name']);const previousName=norm(currentName)===norm(sourceName)?'':sourceName;bootstrapById.set(id,{
  'Store ID':id,'Current Store Name':currentName,'Previous Name':previousName,'Assigned Team':teamNorm(s['Assigned Team']),'Route Day':text(src.Day),'Route Stop':text(src['Stop No.']),'Scheduled Deployment Date':isoScheduled(s.Day),'Scheduled Stop':text(s['Stop No.']),'Actual Visit Date':dateOnly(poeByKey.get(text(s['Store Key']))||''),'Store Category':text(s['Store Category']||src['Store Category']),'Street Address / Location':text(s.Address||src['Street Address / Location']),'Barangay / District':text(s.Barangay||src['Barangay / District']),'City / Area':text(s.Area||src['City / Area']),'Material Allocation':text(s['Material Allocation']||src['Material Allocation']),'Active':text(s.Active||'TRUE'),'Legacy Store Key':text(s['Store Key']),'Identity Status':previousName?'CURRENT_NAME_DIFFERS_FROM_ORIGINAL_SOURCE':'ACTIVE','Last Identity Sync':''
});}
if(bootstrapById.size!==EXPECTED_STORE_COUNT)throw new Error('One-to-one 83-store identity proof failed. No write performed.');

let target=meta.sheets.find(x=>x.properties?.title===TARGET_SHEET);let created=false;let existingValues=[];let existingRows=[];
if(target){existingValues=await getRange(token,SOURCE_SHEET_ID,`'${TARGET_SHEET}'!A1:R500`);if(!existingValues.length)throw new Error('Target sheet exists but is empty. Refusing to guess structure.');const existingHeaders=(existingValues[0]||[]).map(text);if(HEADERS.some((h,i)=>existingHeaders[i]!==h))throw new Error('Target sheet headers differ from expected identity schema. Refusing to overwrite.');existingRows=rowsToObjects(existingValues);const existingIds=existingRows.map(r=>text(r['Store ID'])).filter(Boolean);if(!unique(existingIds))throw new Error('Target identity sheet has duplicate Store IDs. No write performed.');for(const id of ids){if(!existingIds.includes(id))throw new Error(`Target identity sheet is missing baseline ${id}. No write performed.`);} }
else{const added=await batchUpdate(token,SOURCE_SHEET_ID,[{addSheet:{properties:{title:TARGET_SHEET,gridProperties:{rowCount:200,columnCount:18,frozenRowCount:1}}}}]);const sheetId=added.replies?.[0]?.addSheet?.properties?.sheetId;if(sheetId==null)throw new Error('Could not determine new target sheet ID.');target={properties:{sheetId,title:TARGET_SHEET}};created=true;}
const sheetId=target.properties.sheetId;

const now=new Date().toISOString();const changed=[];let managementEditsPreserved=0;let immutableChecks=0;
if(created){const initial=[HEADERS,...ids.map(id=>{const o=bootstrapById.get(id);o['Last Identity Sync']=now;return rowArray(o);})];await putValues(token,SOURCE_SHEET_ID,`'${TARGET_SHEET}'!A1:R${initial.length}`,initial);changed.push(...ids.map((id,i)=>({id,row:i+2,kind:'INITIAL_CREATE'})));}
else{
  const existingById=new Map(existingRows.map(r=>[text(r['Store ID']),r]));
  for(const id of ids){const old=existingById.get(id);const base=bootstrapById.get(id);if(text(old['Legacy Store Key'])!==text(base['Legacy Store Key']))throw new Error(`Immutable Legacy Store Key mismatch for ${id}. No write performed.`);immutableChecks++;
    const merged={...base};
    for(const f of MANAGEMENT_FIELDS){if(text(old[f])!==''){merged[f]=old[f];if(!same(old[f],base[f]))managementEditsPreserved++;}}
    const historyCandidates=[old['Previous Name']];
    if(norm(merged['Current Store Name'])!==norm(base['Current Store Name']))historyCandidates.push(base['Current Store Name']);
    const sourceHistorical=base['Previous Name'];if(sourceHistorical&&norm(sourceHistorical)!==norm(merged['Current Store Name']))historyCandidates.push(sourceHistorical);
    merged['Previous Name']=mergeHistory(...historyCandidates);
    merged['Actual Visit Date']=base['Actual Visit Date']||text(old['Actual Visit Date']);
    const pendingFields=MANAGEMENT_FIELDS.filter(f=>!same(merged[f],base[f]));
    merged['Identity Status']=pendingFields.length?'MANAGEMENT_EDIT_PENDING_SYNC':(merged['Previous Name']?'ACTIVE_WITH_HISTORY':'ACTIVE');
    merged['Last Identity Sync']=text(old['Last Identity Sync']);
    const desired=rowArray(merged);const oldArray=HEADERS.map(h=>old[h]??'');
    if(!arraysEqual(oldArray,desired,17)){merged['Last Identity Sync']=now;const finalRow=rowArray(merged);await putValues(token,SOURCE_SHEET_ID,`'${TARGET_SHEET}'!A${old.__row}:R${old.__row}`,[finalRow]);changed.push({id,row:old.__row,kind:'SYSTEM_MERGE',pendingManagementFields:pendingFields});}
  }
}

await batchUpdate(token,SOURCE_SHEET_ID,[{updateSheetProperties:{properties:{sheetId,gridProperties:{frozenRowCount:1}},fields:'gridProperties.frozenRowCount'}},{repeatCell:{range:{sheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:18},cell:{userEnteredFormat:{textFormat:{bold:true},wrapStrategy:'WRAP'}},fields:'userEnteredFormat(textFormat,wrapStrategy)'}},{autoResizeDimensions:{dimensions:{sheetId,dimension:'COLUMNS',startIndex:0,endIndex:18}}}]);

const verify=await getRange(token,SOURCE_SHEET_ID,`'${TARGET_SHEET}'!A1:R500`);const verifyRows=rowsToObjects(verify);const verifyById=new Map(verifyRows.map(r=>[text(r['Store ID']),r]));
for(const id of ids){const r=verifyById.get(id);if(!r)throw new Error(`Post-merge verification failed: missing ${id}`);if(text(r['Legacy Store Key'])!==text(bootstrapById.get(id)['Legacy Store Key']))throw new Error(`Post-merge verification failed: Legacy Store Key changed for ${id}`);}
if(!unique([...verifyById.keys()].filter(Boolean)))throw new Error('Post-merge verification failed: duplicate Store IDs.');

console.log(JSON.stringify({ok:true,mergePolicy:MERGE_POLICY,sourceStoreCount:source.length,liveStoreCount:live.length,baselineStoreIdsVerified:ids.length,identityRowsPresent:verifyRows.length,rowsWrittenThisRun:changed.length,managementEditsPreserved,immutableStoreIdChecks:ids.length,immutableLegacyStoreKeyChecks:immutableChecks||ids.length,changedRows:changed,actualVisitDatesPopulated:ids.filter(id=>text(verifyById.get(id)?.['Actual Visit Date'])).length,targetSheet:TARGET_SHEET,touchedProductionRuntime:false,touchedV4Stores:false,touchedV4Poe:false,touchedV4Photos:false,touchedPhotoWorker:false,deletes:0},null,2));
