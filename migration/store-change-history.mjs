#!/usr/bin/env node

/**
 * Append-only change history for STORE IDENTITY & SCHEDULE.
 *
 * Safety contract:
 * - reads ONLY the source workbook's STORE IDENTITY & SCHEDULE and STORE CHANGE HISTORY tabs
 * - writes ONLY to source tab STORE CHANGE HISTORY
 * - first run seeds one BASELINE row per current Store ID
 * - subsequent runs append one CHANGE row per management field whose current value differs from history state
 * - Store ID and Legacy Store Key are immutable and are never changed here
 * - never updates/deletes prior history rows
 * - never writes V4_STORES, V4_POE, V4_PHOTOS, Apps Script, Cloudflare, Drive files/folders, or field/photo runtime
 */

const SOURCE_SHEET_ID = process.env.SOURCE_SHEET_ID || '1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
const IDENTITY_SHEET = 'STORE IDENTITY & SCHEDULE';
const HISTORY_SHEET = 'STORE CHANGE HISTORY';
const EXPECTED_BASELINE_COUNT = 83;
const MANAGEMENT_FIELDS = ['Current Store Name','Assigned Team','Route Day','Route Stop','Scheduled Deployment Date','Scheduled Stop','Store Category','Street Address / Location','Barangay / District','City / Area','Material Allocation','Active'];
const HISTORY_HEADERS = ['Event ID','Store ID','Legacy Store Key','Event Type','Field Changed','Old Value','New Value','Changed At','Change Source','Actor'];

function need(name){const v=String(process.env[name]||'').trim();if(!v)throw new Error(`Missing required environment variable: ${name}`);return v;}
function text(v){return String(v??'').trim();}
function rowsToObjects(values){if(!values?.length)return[];const h=values[0].map(text);return values.slice(1).filter(r=>r.some(v=>text(v)!=='')).map((r,i)=>{const o={__row:i+2};h.forEach((k,j)=>{if(k)o[k]=r[j]??'';});return o;});}
function unique(arr){return new Set(arr).size===arr.length;}
function rowFromObject(headers,o){return headers.map(h=>o[h]??'');}
function eventId(storeId,field,at,seq){return `${at.replace(/[-:.TZ]/g,'')}-${storeId}-${String(seq).padStart(3,'0')}-${field.replace(/[^A-Za-z0-9]+/g,'_').slice(0,24)}`;}

async function accessToken(){
  const body=new URLSearchParams({client_id:need('GOOGLE_OAUTH_CLIENT_ID'),client_secret:need('GOOGLE_OAUTH_CLIENT_SECRET'),refresh_token:need('GOOGLE_OAUTH_REFRESH_TOKEN'),grant_type:'refresh_token'});
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
  const j=await r.json();
  if(!r.ok||!j.access_token)throw new Error(`Google OAuth refresh failed: ${r.status}`);
  return j.access_token;
}
async function getRange(token,id,range){
  const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;
  const r=await fetch(u,{headers:{authorization:`Bearer ${token}`}});
  if(!r.ok)throw new Error(`GET ${range} failed: ${r.status} ${await r.text()}`);
  return (await r.json()).values||[];
}
async function getSpreadsheet(token,id){
  const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}?fields=sheets.properties`;
  const r=await fetch(u,{headers:{authorization:`Bearer ${token}`}});
  if(!r.ok)throw new Error(`Spreadsheet metadata failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function batchUpdate(token,id,requests){
  const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}:batchUpdate`;
  const r=await fetch(u,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({requests})});
  if(!r.ok)throw new Error(`batchUpdate failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function putValues(token,id,range,values){
  if(!range.startsWith(`'${HISTORY_SHEET}'!`))throw new Error(`Refusing write outside ${HISTORY_SHEET}: ${range}`);
  const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const r=await fetch(u,{method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({range,majorDimension:'ROWS',values})});
  if(!r.ok)throw new Error(`values.update failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function appendValues(token,id,range,values){
  if(!range.startsWith(`'${HISTORY_SHEET}'!`))throw new Error(`Refusing append outside ${HISTORY_SHEET}: ${range}`);
  const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const r=await fetch(u,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({range,majorDimension:'ROWS',values})});
  if(!r.ok)throw new Error(`values.append failed: ${r.status} ${await r.text()}`);
  return r.json();
}

const token=await accessToken();
const [identityValues,meta]=await Promise.all([
  getRange(token,SOURCE_SHEET_ID,`'${IDENTITY_SHEET}'!A1:R500`),
  getSpreadsheet(token,SOURCE_SHEET_ID)
]);
if(!identityValues.length)throw new Error(`${IDENTITY_SHEET} is missing/empty.`);
const identityRows=rowsToObjects(identityValues);
if(identityRows.length!==EXPECTED_BASELINE_COUNT)throw new Error(`Identity row count ${identityRows.length}; expected ${EXPECTED_BASELINE_COUNT}. No history write performed.`);
const ids=identityRows.map(r=>text(r['Store ID']));
const keys=identityRows.map(r=>text(r['Legacy Store Key']));
if(ids.some(v=>!v)||!unique(ids))throw new Error('Identity Store IDs are blank/duplicated. No history write performed.');
if(keys.some(v=>!v)||!unique(keys))throw new Error('Identity Legacy Store Keys are blank/duplicated. No history write performed.');
for(const f of MANAGEMENT_FIELDS){if(!Object.prototype.hasOwnProperty.call(identityRows[0],f))throw new Error(`Identity management field missing: ${f}`);}

let historySheet=meta.sheets.find(s=>s.properties?.title===HISTORY_SHEET);let created=false;
if(!historySheet){
  const added=await batchUpdate(token,SOURCE_SHEET_ID,[{addSheet:{properties:{title:HISTORY_SHEET,gridProperties:{rowCount:2000,columnCount:HISTORY_HEADERS.length,frozenRowCount:1}}}}]);
  const sheetId=added.replies?.[0]?.addSheet?.properties?.sheetId;
  if(sheetId==null)throw new Error('Could not determine STORE CHANGE HISTORY sheet ID.');
  historySheet={properties:{sheetId,title:HISTORY_SHEET}};created=true;
  await putValues(token,SOURCE_SHEET_ID,`'${HISTORY_SHEET}'!A1:J1`,[HISTORY_HEADERS]);
  await batchUpdate(token,SOURCE_SHEET_ID,[
    {repeatCell:{range:{sheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:HISTORY_HEADERS.length},cell:{userEnteredFormat:{textFormat:{bold:true},wrapStrategy:'WRAP'}},fields:'userEnteredFormat(textFormat,wrapStrategy)'}},
    {autoResizeDimensions:{dimensions:{sheetId,dimension:'COLUMNS',startIndex:0,endIndex:HISTORY_HEADERS.length}}}
  ]);
}

let historyValues=await getRange(token,SOURCE_SHEET_ID,`'${HISTORY_SHEET}'!A1:J10000`);
if(!historyValues.length)throw new Error(`${HISTORY_SHEET} exists but is unreadable/empty.`);
const actualHeaders=(historyValues[0]||[]).map(text);
if(HISTORY_HEADERS.some((h,i)=>actualHeaders[i]!==h))throw new Error('STORE CHANGE HISTORY headers differ from expected schema. Refusing to append.');
let historyRows=rowsToObjects(historyValues);

const now=new Date().toISOString();
const baselineRows=historyRows.filter(r=>text(r['Event Type'])==='BASELINE');
const appendRows=[];
let baselinesSeeded=0;let changesAppended=0;

if(historyRows.length===0){
  let seq=1;
  for(const r of identityRows){
    const storeId=text(r['Store ID']);const legacyKey=text(r['Legacy Store Key']);
    const baseline={};for(const f of MANAGEMENT_FIELDS)baseline[f]=text(r[f]);
    appendRows.push(rowFromObject(HISTORY_HEADERS,{
      'Event ID':eventId(storeId,'BASELINE',now,seq++),'Store ID':storeId,'Legacy Store Key':legacyKey,'Event Type':'BASELINE','Field Changed':'__BASELINE__','Old Value':'','New Value':JSON.stringify(baseline),'Changed At':now,'Change Source':IDENTITY_SHEET,'Actor':'SYSTEM_BASELINE'
    }));
    baselinesSeeded++;
  }
}else{
  if(baselineRows.length!==EXPECTED_BASELINE_COUNT)throw new Error(`History baseline count ${baselineRows.length}; expected ${EXPECTED_BASELINE_COUNT}. Refusing append.`);
  const baselineById=new Map();
  for(const b of baselineRows){const id=text(b['Store ID']);if(baselineById.has(id))throw new Error(`Duplicate BASELINE for ${id}.`);baselineById.set(id,b);}
  for(const id of ids)if(!baselineById.has(id))throw new Error(`History missing BASELINE for ${id}.`);

  const stateById=new Map();
  for(const [id,b] of baselineById){
    let baseline;try{baseline=JSON.parse(text(b['New Value']));}catch{throw new Error(`Invalid baseline JSON for ${id}.`);}
    const key=text(b['Legacy Store Key']);stateById.set(id,{legacyKey:key,values:{...baseline}});
  }
  for(const h of historyRows){
    if(text(h['Event Type'])!=='CHANGE')continue;
    const id=text(h['Store ID']);const st=stateById.get(id);if(!st)throw new Error(`CHANGE event references unknown Store ID ${id}.`);
    if(text(h['Legacy Store Key'])!==st.legacyKey)throw new Error(`History Legacy Store Key mismatch for ${id}.`);
    const field=text(h['Field Changed']);if(!MANAGEMENT_FIELDS.includes(field))throw new Error(`History contains unsupported management field ${field}.`);
    st.values[field]=text(h['New Value']);
  }

  let seq=1;
  for(const r of identityRows){
    const id=text(r['Store ID']);const key=text(r['Legacy Store Key']);const st=stateById.get(id);
    if(!st)throw new Error(`No reconstructed history state for ${id}.`);
    if(st.legacyKey!==key)throw new Error(`Immutable Legacy Store Key changed for ${id}. Refusing history append.`);
    for(const field of MANAGEMENT_FIELDS){
      const oldValue=text(st.values[field]);const newValue=text(r[field]);
      if(oldValue===newValue)continue;
      appendRows.push(rowFromObject(HISTORY_HEADERS,{
        'Event ID':eventId(id,field,now,seq++),'Store ID':id,'Legacy Store Key':key,'Event Type':'CHANGE','Field Changed':field,'Old Value':oldValue,'New Value':newValue,'Changed At':now,'Change Source':IDENTITY_SHEET,'Actor':'WORKBOOK_EDITOR_UNAVAILABLE'
      }));
      st.values[field]=newValue;changesAppended++;
    }
  }
}

if(appendRows.length)await appendValues(token,SOURCE_SHEET_ID,`'${HISTORY_SHEET}'!A:J`,appendRows);

historyValues=await getRange(token,SOURCE_SHEET_ID,`'${HISTORY_SHEET}'!A1:J10000`);
historyRows=rowsToObjects(historyValues);
const verifyBaselines=historyRows.filter(r=>text(r['Event Type'])==='BASELINE');
if(verifyBaselines.length!==EXPECTED_BASELINE_COUNT)throw new Error(`Post-write baseline verification failed: ${verifyBaselines.length}`);
const eventIds=historyRows.map(r=>text(r['Event ID']));if(eventIds.some(v=>!v)||!unique(eventIds))throw new Error('Post-write history Event IDs blank/duplicated.');

console.log(JSON.stringify({
  ok:true,historyPolicy:'APPEND_ONLY',identityRows:identityRows.length,historyRows:historyRows.length,baselinesSeeded,changesAppended,rowsAppendedThisRun:appendRows.length,targetSheet:HISTORY_SHEET,immutableStoreIdsVerified:ids.length,immutableLegacyKeysVerified:keys.length,touchedV4Stores:false,touchedV4Poe:false,touchedV4Photos:false,touchedDrive:false,touchedPhotoWorker:false,deletes:0
},null,2));
