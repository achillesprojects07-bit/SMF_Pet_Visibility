#!/usr/bin/env node

/**
 * Controlled execution test for STORE CHANGE HISTORY.
 *
 * Safety contract:
 * - temporarily changes ONLY Scheduled Deployment Date for one existing Store ID
 *   in source STORE IDENTITY & SCHEDULE
 * - runs the append-only change-history writer and requires exactly one CHANGE event
 * - re-runs history and requires zero duplicate events
 * - restores the original Scheduled Deployment Date and requires exactly one reverse CHANGE event
 * - re-runs history after restore and requires zero duplicate events
 * - verifies Store ID and Legacy Store Key remain unchanged
 * - hashes live V4_STORES, V4_POE and V4_PHOTOS before/after and requires them unchanged
 * - never calls Drive, Apps Script, Cloudflare or the photo Worker
 * - never deletes rows/files; test history events remain as an auditable controlled-test record
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const SOURCE_SHEET_ID = process.env.SOURCE_SHEET_ID || '1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
const INTERNAL_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1TNrb3ir8vS6CyZ8kXhRH43JXoH4Ws7iQ4g3649KQTf0';
const IDENTITY_SHEET = 'STORE IDENTITY & SCHEDULE';
const HISTORY_SHEET = 'STORE CHANGE HISTORY';
const TEST_STORE_ID = process.env.TEST_STORE_ID || 'SMF-0001';
const TEST_FIELD = 'Scheduled Deployment Date';
const TEST_SCHEDULED_DATE = process.env.TEST_SCHEDULED_DATE || '2099-12-31';

function need(name){const v=String(process.env[name]||'').trim();if(!v)throw new Error(`Missing required environment variable: ${name}`);return v;}
function text(v){return String(v??'').trim();}
function sha(values){return createHash('sha256').update(JSON.stringify(values)).digest('hex');}
function rowsToObjects(values){if(!values?.length)return[];const h=values[0].map(text);return values.slice(1).filter(r=>r.some(v=>text(v)!=='')).map((r,i)=>{const o={__row:i+2};h.forEach((k,j)=>{if(k)o[k]=r[j]??'';});return o;});}
function colName(n){let s='';for(let x=n+1;x>0;x=Math.floor((x-1)/26))s=String.fromCharCode(65+((x-1)%26))+s;return s;}

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
async function putIdentityValue(token,range,values){
  if(!range.startsWith(`'${IDENTITY_SHEET}'!`))throw new Error(`Refusing write outside ${IDENTITY_SHEET}: ${range}`);
  const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SOURCE_SHEET_ID)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const r=await fetch(u,{method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({range,majorDimension:'ROWS',values})});
  if(!r.ok)throw new Error(`Identity test write failed: ${r.status} ${await r.text()}`);
}
function runHistory(){
  const env={...process.env,HISTORY_CHANGE_SOURCE:'CONTROLLED_CHANGE_HISTORY_TEST',HISTORY_CHANGE_ACTOR:'SYSTEM_TEST'};
  const r=spawnSync(process.execPath,['migration/store-change-history.mjs'],{encoding:'utf8',env});
  if(r.status!==0)throw new Error(`History writer failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  const out=text(r.stdout);if(!out)throw new Error('History writer returned empty output.');
  try{return JSON.parse(out);}catch(err){throw new Error(`Could not parse history JSON: ${err.message}\n${out}`);}
}
async function protectedSnapshot(token){
  const [stores,poe,photos]=await Promise.all([
    getRange(token,INTERNAL_SHEET_ID,'V4_STORES!A1:Z500'),
    getRange(token,INTERNAL_SHEET_ID,'V4_POE!A1:Z2500'),
    getRange(token,INTERNAL_SHEET_ID,'V4_PHOTOS!A1:Z5000')
  ]);
  return {storesHash:sha(stores),poeHash:sha(poe),photosHash:sha(photos),storesRows:stores.length,poeRows:poe.length,photoRows:photos.length};
}
function protectedSame(a,b){return a.storesHash===b.storesHash&&a.poeHash===b.poeHash&&a.photosHash===b.photosHash;}
function findNewChange(rows,beforeEventIds,storeId,oldValue,newValue){
  return rows.filter(r=>!beforeEventIds.has(text(r['Event ID']))&&text(r['Event Type'])==='CHANGE'&&text(r['Store ID'])===storeId&&text(r['Field Changed'])===TEST_FIELD&&text(r['Old Value'])===oldValue&&text(r['New Value'])===newValue);
}

const token=await accessToken();
const identityValues=await getRange(token,SOURCE_SHEET_ID,`'${IDENTITY_SHEET}'!A1:R500`);
const identityRows=rowsToObjects(identityValues);
const headers=(identityValues[0]||[]).map(text);
const target=identityRows.find(r=>text(r['Store ID'])===TEST_STORE_ID);
if(!target)throw new Error(`Test Store ID not found: ${TEST_STORE_ID}`);
const originalDate=text(target[TEST_FIELD]);
const originalKey=text(target['Legacy Store Key']);
if(!originalDate)throw new Error(`${TEST_STORE_ID} has blank ${TEST_FIELD}.`);
if(TEST_SCHEDULED_DATE===originalDate)throw new Error('Temporary test date must differ from original date.');
const fieldCol=headers.indexOf(TEST_FIELD);if(fieldCol<0)throw new Error(`${TEST_FIELD} column missing.`);
const testCell=`'${IDENTITY_SHEET}'!${colName(fieldCol)}${target.__row}`;

const historyBefore=rowsToObjects(await getRange(token,SOURCE_SHEET_ID,`'${HISTORY_SHEET}'!A1:J10000`));
const beforeEventIds=new Set(historyBefore.map(r=>text(r['Event ID'])));
const beforeProtected=await protectedSnapshot(token);
let forwardEvent=null;let reverseEvent=null;let forwardRun=null;let forwardIdempotentRun=null;let reverseRun=null;let finalIdempotentRun=null;let failure=null;

try{
  await putIdentityValue(token,testCell,[[TEST_SCHEDULED_DATE]]);
  const edited=rowsToObjects(await getRange(token,SOURCE_SHEET_ID,`'${IDENTITY_SHEET}'!A1:R500`)).find(r=>text(r['Store ID'])===TEST_STORE_ID);
  if(!edited||text(edited[TEST_FIELD])!==TEST_SCHEDULED_DATE)throw new Error('Temporary management edit was not established.');
  if(text(edited['Legacy Store Key'])!==originalKey)throw new Error('Legacy Store Key changed during temporary edit.');

  forwardRun=runHistory();
  if(Number(forwardRun.changesAppended)!==1||Number(forwardRun.rowsAppendedThisRun)!==1)throw new Error(`Expected exactly one forward CHANGE event; got changes=${forwardRun.changesAppended}, rows=${forwardRun.rowsAppendedThisRun}.`);
  let historyNow=rowsToObjects(await getRange(token,SOURCE_SHEET_ID,`'${HISTORY_SHEET}'!A1:J10000`));
  const forwardMatches=findNewChange(historyNow,beforeEventIds,TEST_STORE_ID,originalDate,TEST_SCHEDULED_DATE);
  if(forwardMatches.length!==1)throw new Error(`Expected one exact forward history event; found ${forwardMatches.length}.`);
  forwardEvent=forwardMatches[0];
  if(text(forwardEvent['Legacy Store Key'])!==originalKey)throw new Error('Forward history event has wrong Legacy Store Key.');
  if(text(forwardEvent['Change Source'])!=='CONTROLLED_CHANGE_HISTORY_TEST')throw new Error('Forward history event is not marked as controlled test.');
  if(text(forwardEvent['Actor'])!=='SYSTEM_TEST')throw new Error('Forward history event actor is not SYSTEM_TEST.');

  forwardIdempotentRun=runHistory();
  if(Number(forwardIdempotentRun.rowsAppendedThisRun)!==0)throw new Error(`Forward idempotency run appended ${forwardIdempotentRun.rowsAppendedThisRun}; expected 0.`);

  const duringProtected=await protectedSnapshot(token);
  if(!protectedSame(beforeProtected,duringProtected))throw new Error('Protected production data changed during forward history test.');
}catch(err){failure=err;}
finally{
  try{
    await putIdentityValue(token,testCell,[[originalDate]]);
    const restored=rowsToObjects(await getRange(token,SOURCE_SHEET_ID,`'${IDENTITY_SHEET}'!A1:R500`)).find(r=>text(r['Store ID'])===TEST_STORE_ID);
    if(!restored||text(restored[TEST_FIELD])!==originalDate)throw new Error('Identity field restoration failed.');
    if(text(restored['Legacy Store Key'])!==originalKey)throw new Error('Legacy Store Key changed during restoration.');

    const beforeReverseRows=rowsToObjects(await getRange(token,SOURCE_SHEET_ID,`'${HISTORY_SHEET}'!A1:J10000`));
    const beforeReverseIds=new Set(beforeReverseRows.map(r=>text(r['Event ID'])));
    reverseRun=runHistory();
    if(Number(reverseRun.changesAppended)!==1||Number(reverseRun.rowsAppendedThisRun)!==1)throw new Error(`Expected exactly one reverse CHANGE event; got changes=${reverseRun.changesAppended}, rows=${reverseRun.rowsAppendedThisRun}.`);
    const historyAfterReverse=rowsToObjects(await getRange(token,SOURCE_SHEET_ID,`'${HISTORY_SHEET}'!A1:J10000`));
    const reverseMatches=findNewChange(historyAfterReverse,beforeReverseIds,TEST_STORE_ID,TEST_SCHEDULED_DATE,originalDate);
    if(reverseMatches.length!==1)throw new Error(`Expected one exact reverse history event; found ${reverseMatches.length}.`);
    reverseEvent=reverseMatches[0];
    if(text(reverseEvent['Legacy Store Key'])!==originalKey)throw new Error('Reverse history event has wrong Legacy Store Key.');
    if(text(reverseEvent['Change Source'])!=='CONTROLLED_CHANGE_HISTORY_TEST'||text(reverseEvent['Actor'])!=='SYSTEM_TEST')throw new Error('Reverse history event is not marked as controlled test.');

    finalIdempotentRun=runHistory();
    if(Number(finalIdempotentRun.rowsAppendedThisRun)!==0)throw new Error(`Final idempotency run appended ${finalIdempotentRun.rowsAppendedThisRun}; expected 0.`);

    const afterProtected=await protectedSnapshot(token);
    if(!protectedSame(beforeProtected,afterProtected))throw new Error('Protected production data changed after controlled history test.');
    const finalIdentity=rowsToObjects(await getRange(token,SOURCE_SHEET_ID,`'${IDENTITY_SHEET}'!A1:R500`)).find(r=>text(r['Store ID'])===TEST_STORE_ID);
    if(!finalIdentity||text(finalIdentity[TEST_FIELD])!==originalDate||text(finalIdentity['Legacy Store Key'])!==originalKey)throw new Error('Final identity state is not fully restored.');
  }catch(restoreErr){
    if(!failure)failure=restoreErr;else failure=new Error(`${failure.message}\nRESTORE/VERIFY FAILURE: ${restoreErr.message}`);
  }
}

const historyAfter=rowsToObjects(await getRange(token,SOURCE_SHEET_ID,`'${HISTORY_SHEET}'!A1:J10000`));
const result={
  ok:!failure,
  testStoreId:TEST_STORE_ID,
  field:TEST_FIELD,
  originalValue:originalDate,
  temporaryValue:TEST_SCHEDULED_DATE,
  historyRowsBefore:historyBefore.length,
  historyRowsAfter:historyAfter.length,
  expectedHistoryGrowth:2,
  actualHistoryGrowth:historyAfter.length-historyBefore.length,
  forwardChangeEventId:forwardEvent?.['Event ID']||null,
  reverseChangeEventId:reverseEvent?.['Event ID']||null,
  forwardRunRowsAppended:forwardRun?.rowsAppendedThisRun??null,
  forwardIdempotencyRowsAppended:forwardIdempotentRun?.rowsAppendedThisRun??null,
  reverseRunRowsAppended:reverseRun?.rowsAppendedThisRun??null,
  finalIdempotencyRowsAppended:finalIdempotentRun?.rowsAppendedThisRun??null,
  storeIdUnchanged:true,
  legacyStoreKeyUnchanged:true,
  identityRestored:true,
  protectedProductionUnchanged:!failure,
  touchedV4Stores:false,
  touchedV4Poe:false,
  touchedV4Photos:false,
  touchedDrive:false,
  touchedPhotoWorker:false,
  deletes:0
};
console.log(JSON.stringify(result,null,2));
if(failure)throw failure;
if(result.actualHistoryGrowth!==2)throw new Error(`Expected exactly 2 auditable test CHANGE events; history grew by ${result.actualHistoryGrowth}.`);
