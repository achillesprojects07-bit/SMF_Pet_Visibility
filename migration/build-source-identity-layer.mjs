#!/usr/bin/env node

/**
 * Build the source workbook's STORE IDENTITY & SCHEDULE layer.
 *
 * Safety contract:
 * - reads source STORE MASTER + MATERIALS and live V4_STORES/V4_POE
 * - writes ONLY to a dedicated source-workbook tab named STORE IDENTITY & SCHEDULE
 * - never writes V4_STORES, V4_POE, V4_PHOTOS, Apps Script, Cloudflare, or Drive files/folders
 * - never changes an existing Store ID or Store Key
 * - never deletes rows or files
 * - aborts before writing unless all 83 source stores resolve one-to-one to the 83 live Store IDs
 */

const SOURCE_SHEET_ID = process.env.SOURCE_SHEET_ID || '1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
const INTERNAL_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1TNrb3ir8vS6CyZ8kXhRH43JXoH4Ws7iQ4g3649KQTf0';
const TARGET_SHEET = 'STORE IDENTITY & SCHEDULE';
const EXPECTED_STORE_COUNT = 83;

function need(name){
  const v=String(process.env[name]||'').trim();
  if(!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
function norm(v){
  return String(v??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
}
function teamNorm(v){
  const m=String(v??'').match(/team\s*(\d+)/i);
  return m?`Team ${m[1]}`:String(v??'').trim();
}
function rowsToObjects(values){
  if(!values?.length) return [];
  const h=values[0].map(v=>String(v??'').trim());
  return values.slice(1).filter(r=>r.some(v=>String(v??'').trim()!=='' )).map((r,i)=>{
    const o={__row:i+2};
    h.forEach((k,j)=>{if(k)o[k]=r[j]??'';});
    return o;
  });
}
function legacyNameFromKey(key){
  const p=String(key??'').split('|');
  return p.length>=4?p.slice(3).join('|').trim():'';
}
function unique(arr){return new Set(arr).size===arr.length;}
function isoScheduled(v){
  const s=String(v||'').trim();
  const m=s.match(/^Sept\s+(\d{1,2})$/i);
  if(!m) return s;
  return `2026-09-${String(Number(m[1])).padStart(2,'0')}`;
}
function dateOnly(v){
  const s=String(v||'').trim();
  if(!s) return '';
  const m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if(!m) return '';
  return `${m[3]}-${String(Number(m[1])).padStart(2,'0')}-${String(Number(m[2])).padStart(2,'0')}`;
}
function dateRank(v){
  const d=dateOnly(v);
  return d?Date.parse(`${d}T00:00:00Z`):0;
}

async function accessToken(){
  const body=new URLSearchParams({client_id:need('GOOGLE_OAUTH_CLIENT_ID'),client_secret:need('GOOGLE_OAUTH_CLIENT_SECRET'),refresh_token:need('GOOGLE_OAUTH_REFRESH_TOKEN'),grant_type:'refresh_token'});
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
  const j=await r.json();
  if(!r.ok||!j.access_token) throw new Error(`Google OAuth refresh failed: ${r.status}`);
  return j.access_token;
}
async function getRange(token,id,range){
  const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;
  const r=await fetch(u,{headers:{authorization:`Bearer ${token}`}});
  if(!r.ok) throw new Error(`GET ${range} failed: ${r.status} ${await r.text()}`);
  return (await r.json()).values||[];
}
async function getSpreadsheet(token,id){
  const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}?fields=sheets.properties`;
  const r=await fetch(u,{headers:{authorization:`Bearer ${token}`}});
  if(!r.ok) throw new Error(`Spreadsheet metadata failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function batchUpdate(token,id,requests){
  const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}:batchUpdate`;
  const r=await fetch(u,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({requests})});
  if(!r.ok) throw new Error(`batchUpdate failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function putValues(token,id,range,values){
  const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const r=await fetch(u,{method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({range,majorDimension:'ROWS',values})});
  if(!r.ok) throw new Error(`values.update failed: ${r.status} ${await r.text()}`);
  return r.json();
}

function matchSource(src,live){
  const team=teamNorm(src['Assigned Team']);
  const name=norm(src['Store Name']);
  const addr=norm(src['Street Address / Location']);
  const same=live.filter(s=>teamNorm(s['Assigned Team'])===team);
  const byName=same.filter(s=>name&&(name===norm(s['Store Name'])||name===norm(legacyNameFromKey(s['Store Key']))));
  if(byName.length===1) return byName[0];
  if(byName.length>1) throw new Error(`Ambiguous name match: ${src['Store Name']}`);
  const byAddr=same.filter(s=>addr&&addr===norm(s['Address']));
  if(byAddr.length===1) return byAddr[0];
  if(byAddr.length>1) throw new Error(`Ambiguous address match: ${src['Store Name']}`);
  throw new Error(`No safe live Store ID match for source store: ${src['Store Name']}`);
}

const token=await accessToken();
const [sourceValues,liveValues,poeValues]=await Promise.all([
  getRange(token,SOURCE_SHEET_ID,"'STORE MASTER + MATERIALS'!A1:L500"),
  getRange(token,INTERNAL_SHEET_ID,'V4_STORES!A1:R500'),
  getRange(token,INTERNAL_SHEET_ID,'V4_POE!A1:S2000')
]);
const source=rowsToObjects(sourceValues);
const live=rowsToObjects(liveValues);
const poe=rowsToObjects(poeValues).filter(r=>String(r.Environment||'').toUpperCase()==='LIVE');

if(source.length!==EXPECTED_STORE_COUNT) throw new Error(`Source store count ${source.length}; expected ${EXPECTED_STORE_COUNT}. No write performed.`);
if(live.length!==EXPECTED_STORE_COUNT) throw new Error(`Live store count ${live.length}; expected ${EXPECTED_STORE_COUNT}. No write performed.`);
const ids=live.map(s=>String(s['Store ID']||'').trim());
const keys=live.map(s=>String(s['Store Key']||'').trim());
if(ids.some(v=>!v)||!unique(ids)) throw new Error('Live Store IDs are blank/duplicated. No write performed.');
if(keys.some(v=>!v)||!unique(keys)) throw new Error('Live Store Keys are blank/duplicated. No write performed.');

const poeByKey=new Map();
for(const r of poe){
  const k=String(r['Store Key']||'').trim();
  if(!k) continue;
  const completed=String(r['Completed At']||'').trim();
  if(!completed) continue;
  const prev=poeByKey.get(k);
  if(!prev||dateRank(completed)>dateRank(prev)) poeByKey.set(k,completed);
}

const matchedIds=new Set();
const rows=[];
for(const src of source){
  const s=matchSource(src,live);
  const id=String(s['Store ID']||'').trim();
  if(matchedIds.has(id)) throw new Error(`Store ID matched more than once: ${id}. No write performed.`);
  matchedIds.add(id);
  const currentName=String(s['Store Name']||'').trim();
  const sourceName=String(src['Store Name']||'').trim();
  const previousName=norm(currentName)===norm(sourceName)?'':sourceName;
  rows.push([
    id,
    currentName,
    previousName,
    teamNorm(s['Assigned Team']),
    String(src.Day||'').trim(),
    String(src['Stop No.']||'').trim(),
    isoScheduled(s.Day),
    String(s['Stop No.']||'').trim(),
    dateOnly(poeByKey.get(String(s['Store Key']||'').trim())||''),
    String(s['Store Category']||src['Store Category']||'').trim(),
    String(s.Address||src['Street Address / Location']||'').trim(),
    String(s.Barangay||src['Barangay / District']||'').trim(),
    String(s.Area||src['City / Area']||'').trim(),
    String(s['Material Allocation']||src['Material Allocation']||'').trim(),
    String(s.Active||'TRUE').trim(),
    String(s['Store Key']||'').trim(),
    previousName?'CURRENT_NAME_DIFFERS_FROM_ORIGINAL_SOURCE':'ACTIVE',
    new Date().toISOString()
  ]);
}
if(rows.length!==EXPECTED_STORE_COUNT||matchedIds.size!==EXPECTED_STORE_COUNT) throw new Error('One-to-one 83-store identity proof failed. No write performed.');

const headers=['Store ID','Current Store Name','Previous Name','Assigned Team','Route Day','Route Stop','Scheduled Deployment Date','Scheduled Stop','Actual Visit Date','Store Category','Street Address / Location','Barangay / District','City / Area','Material Allocation','Active','Legacy Store Key','Identity Status','Last Identity Sync'];
const meta=await getSpreadsheet(token,SOURCE_SHEET_ID);
let target=meta.sheets.find(x=>x.properties?.title===TARGET_SHEET);
if(target){
  const existing=await getRange(token,SOURCE_SHEET_ID,`'${TARGET_SHEET}'!A1:R100`);
  if(existing.length && String(existing[0]?.[0]||'').trim()!=='Store ID') throw new Error('Target sheet exists with unexpected content. Refusing to overwrite.');
}else{
  const added=await batchUpdate(token,SOURCE_SHEET_ID,[{addSheet:{properties:{title:TARGET_SHEET,gridProperties:{rowCount:200,columnCount:18,frozenRowCount:1}}}}]);
  const sheetId=added.replies?.[0]?.addSheet?.properties?.sheetId;
  if(sheetId==null) throw new Error('Could not determine new target sheet ID.');
  target={properties:{sheetId,title:TARGET_SHEET}};
}
const sheetId=target.properties.sheetId;

await putValues(token,SOURCE_SHEET_ID,`'${TARGET_SHEET}'!A1:R84`,[headers,...rows]);
await batchUpdate(token,SOURCE_SHEET_ID,[
  {updateSheetProperties:{properties:{sheetId,gridProperties:{frozenRowCount:1}},fields:'gridProperties.frozenRowCount'}},
  {repeatCell:{range:{sheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:18},cell:{userEnteredFormat:{textFormat:{bold:true},wrapStrategy:'WRAP'}},fields:'userEnteredFormat(textFormat,wrapStrategy)'}},
  {autoResizeDimensions:{dimensions:{sheetId,dimension:'COLUMNS',startIndex:0,endIndex:18}}},
  {updateCells:{range:{sheetId,startRowIndex:0,endRowIndex:84,startColumnIndex:0,endColumnIndex:18},rows:[],fields:'userEnteredFormat.wrapStrategy'}}
]);

const verify=await getRange(token,SOURCE_SHEET_ID,`'${TARGET_SHEET}'!A1:R100`);
const verifyRows=rowsToObjects(verify);
const verifyIds=verifyRows.map(r=>String(r['Store ID']||'').trim());
if(verifyRows.length!==EXPECTED_STORE_COUNT) throw new Error(`Post-write verification failed: ${verifyRows.length} rows, expected 83.`);
if(!unique(verifyIds)||verifyIds.some(v=>!v)) throw new Error('Post-write verification failed: Store IDs are blank/duplicated.');
for(const id of ids){if(!verifyIds.includes(id)) throw new Error(`Post-write verification failed: missing ${id}`);}

console.log(JSON.stringify({
  ok:true,
  sourceStoreCount:source.length,
  liveStoreCount:live.length,
  identityRowsWritten:verifyRows.length,
  uniqueStoreIds:unique(verifyIds),
  renamedStores:rows.filter(r=>r[2]).map(r=>({storeId:r[0],currentName:r[1],previousName:r[2]})),
  actualVisitDatesPopulated:rows.filter(r=>r[8]).length,
  targetSheet:TARGET_SHEET,
  touchedProductionRuntime:false,
  touchedV4Stores:false,
  touchedV4Poe:false,
  touchedV4Photos:false,
  touchedPhotoWorker:false,
  deletes:0
},null,2));