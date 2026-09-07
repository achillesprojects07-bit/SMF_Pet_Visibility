#!/usr/bin/env node

/**
 * Controlled management-edit preservation test for STORE IDENTITY & SCHEDULE.
 *
 * Safety contract:
 * - temporarily changes ONLY Scheduled Deployment Date for one existing Store ID
 *   in the source workbook's STORE IDENTITY & SCHEDULE tab
 * - runs the normal identity merge and proves the management edit survives
 * - restores the original value in a finally block
 * - runs the merge again to normalize status, then once more to prove idempotency
 * - reads V4_STORES, V4_POE and V4_PHOTOS before/after and requires byte-equivalent
 *   value snapshots; never writes those tables
 * - never calls Drive, Apps Script or Cloudflare
 * - never deletes rows/files
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const SOURCE_SHEET_ID = process.env.SOURCE_SHEET_ID || '1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
const INTERNAL_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1TNrb3ir8vS6CyZ8kXhRH43JXoH4Ws7iQ4g3649KQTf0';
const TARGET_SHEET = 'STORE IDENTITY & SCHEDULE';
const TEST_STORE_ID = process.env.TEST_STORE_ID || 'SMF-0001';
const TEST_SCHEDULED_DATE = process.env.TEST_SCHEDULED_DATE || '2099-12-31';
const HEADERS = ['Store ID','Current Store Name','Previous Name','Assigned Team','Route Day','Route Stop','Scheduled Deployment Date','Scheduled Stop','Actual Visit Date','Store Category','Street Address / Location','Barangay / District','City / Area','Material Allocation','Active','Legacy Store Key','Identity Status','Last Identity Sync'];

function need(name){const v=String(process.env[name]||'').trim();if(!v)throw new Error(`Missing required environment variable: ${name}`);return v;}
function text(v){return String(v??'').trim();}
function sha(values){return createHash('sha256').update(JSON.stringify(values)).digest('hex');}
function colName(n){let s='';for(let x=n+1;x>0;x=Math.floor((x-1)/26))s=String.fromCharCode(65+((x-1)%26))+s;return s;}
function rowsToObjects(values){if(!values?.length)return[];const h=values[0].map(text);return values.slice(1).filter(r=>r.some(v=>text(v)!=='')).map((r,i)=>{const o={__row:i+2};h.forEach((k,j)=>{if(k)o[k]=r[j]??'';});return o;});}

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
async function putValues(token,id,range,values){
  if(!range.startsWith(`'${TARGET_SHEET}'!`))throw new Error(`Refusing write outside ${TARGET_SHEET}: ${range}`);
  const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const r=await fetch(u,{method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({range,majorDimension:'ROWS',values})});
  if(!r.ok)throw new Error(`values.update failed: ${r.status} ${await r.text()}`);
  return r.json();
}
function runBuilder(){
  const r=spawnSync(process.execPath,['migration/build-source-identity-layer.mjs'],{encoding:'utf8',env:process.env});
  if(r.status!==0)throw new Error(`Identity builder failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  const out=text(r.stdout);
  if(!out)throw new Error('Identity builder returned empty output.');
  try{return {raw:out,json:JSON.parse(out)};}
  catch(err){throw new Error(`Could not parse builder JSON output: ${err.message}\n${out}`);}
}
async function protectedSnapshot(token){
  const [stores,poe,photos]=await Promise.all([
    getRange(token,INTERNAL_SHEET_ID,'V4_STORES!A1:Z500'),
    getRange(token,INTERNAL_SHEET_ID,'V4_POE!A1:Z2500'),
    getRange(token,INTERNAL_SHEET_ID,'V4_PHOTOS!A1:Z5000')
  ]);
  return {storesHash:sha(stores),poeHash:sha(poe),photosHash:sha(photos),storesRows:stores.length,poeRows:poe.length,photoRows:photos.length};
}
function sameProtected(a,b){return a.storesHash===b.storesHash&&a.poeHash===b.poeHash&&a.photosHash===b.photosHash;}

const token=await accessToken();
const originalIdentityValues=await getRange(token,SOURCE_SHEET_ID,`'${TARGET_SHEET}'!A1:R500`);
if(!originalIdentityValues.length)throw new Error(`${TARGET_SHEET} is missing/empty.`);
const headers=(originalIdentityValues[0]||[]).map(text);
for(let i=0;i<HEADERS.length;i++)if(headers[i]!==HEADERS[i])throw new Error(`Unexpected identity header at column ${i+1}: ${headers[i]}`);
const originalRows=rowsToObjects(originalIdentityValues);
const target=originalRows.find(r=>text(r['Store ID'])===TEST_STORE_ID);
if(!target)throw new Error(`Test Store ID not found: ${TEST_STORE_ID}`);
const originalDate=text(target['Scheduled Deployment Date']);
const originalKey=text(target['Legacy Store Key']);
if(!originalDate)throw new Error(`Test store ${TEST_STORE_ID} has blank Scheduled Deployment Date.`);
if(TEST_SCHEDULED_DATE===originalDate)throw new Error('Test date must differ from original date.');
const scheduleCol=headers.indexOf('Scheduled Deployment Date');
if(scheduleCol<0)throw new Error('Scheduled Deployment Date column missing.');
const scheduleCell=`'${TARGET_SHEET}'!${colName(scheduleCol)}${target.__row}`;
const beforeProtected=await protectedSnapshot(token);
let testPreserved=false;
let restoreVerified=false;
let finalIdempotent=false;
let firstMerge=null;
let restoreMerge=null;
let finalMerge=null;
let failure=null;

try{
  await putValues(token,SOURCE_SHEET_ID,scheduleCell,[[TEST_SCHEDULED_DATE]]);
  const edited=rowsToObjects(await getRange(token,SOURCE_SHEET_ID,`'${TARGET_SHEET}'!A1:R500`)).find(r=>text(r['Store ID'])===TEST_STORE_ID);
  if(!edited||text(edited['Scheduled Deployment Date'])!==TEST_SCHEDULED_DATE)throw new Error('Could not establish temporary management edit.');
  if(text(edited['Legacy Store Key'])!==originalKey)throw new Error('Legacy Store Key changed while establishing test edit.');

  firstMerge=runBuilder();
  const afterMerge=rowsToObjects(await getRange(token,SOURCE_SHEET_ID,`'${TARGET_SHEET}'!A1:R500`)).find(r=>text(r['Store ID'])===TEST_STORE_ID);
  if(!afterMerge)throw new Error('Test Store ID disappeared after merge.');
  if(text(afterMerge['Store ID'])!==TEST_STORE_ID)throw new Error('Store ID changed after merge.');
  if(text(afterMerge['Legacy Store Key'])!==originalKey)throw new Error('Legacy Store Key changed after merge.');
  if(text(afterMerge['Scheduled Deployment Date'])!==TEST_SCHEDULED_DATE)throw new Error(`Management edit was overwritten: expected ${TEST_SCHEDULED_DATE}, got ${afterMerge['Scheduled Deployment Date']}`);
  if(text(afterMerge['Identity Status'])!=='MANAGEMENT_EDIT_PENDING_SYNC')throw new Error(`Expected MANAGEMENT_EDIT_PENDING_SYNC, got ${afterMerge['Identity Status']}`);
  if(Number(firstMerge.json.managementEditsPreserved||0)<1)throw new Error('Builder did not report a preserved management edit.');
  const duringProtected=await protectedSnapshot(token);
  if(!sameProtected(beforeProtected,duringProtected))throw new Error('Protected production sheet values changed during management-edit test.');
  testPreserved=true;
}catch(err){failure=err;}
finally{
  try{
    await putValues(token,SOURCE_SHEET_ID,scheduleCell,[[originalDate]]);
    restoreMerge=runBuilder();
    const restored=rowsToObjects(await getRange(token,SOURCE_SHEET_ID,`'${TARGET_SHEET}'!A1:R500`)).find(r=>text(r['Store ID'])===TEST_STORE_ID);
    if(!restored)throw new Error('Test Store ID missing after restoration.');
    if(text(restored['Scheduled Deployment Date'])!==originalDate)throw new Error(`Restoration failed: expected ${originalDate}, got ${restored['Scheduled Deployment Date']}`);
    if(text(restored['Legacy Store Key'])!==originalKey)throw new Error('Legacy Store Key changed after restoration.');
    restoreVerified=true;

    finalMerge=runBuilder();
    if(Number(finalMerge.json.rowsWrittenThisRun)!==0)throw new Error(`Final idempotency run wrote ${finalMerge.json.rowsWrittenThisRun} rows; expected 0.`);
    const afterProtected=await protectedSnapshot(token);
    if(!sameProtected(beforeProtected,afterProtected))throw new Error('Protected production sheet values differ after restoration.');
    finalIdempotent=true;
  }catch(restoreErr){
    if(!failure)failure=restoreErr;
    else failure=new Error(`${failure.message}\nRESTORE/VERIFY FAILURE: ${restoreErr.message}`);
  }
}

const result={
  ok:!failure&&testPreserved&&restoreVerified&&finalIdempotent,
  testStoreId:TEST_STORE_ID,
  originalScheduledDeploymentDate:originalDate,
  temporaryTestScheduledDeploymentDate:TEST_SCHEDULED_DATE,
  managementEditPreserved:testPreserved,
  restoredToOriginal:restoreVerified,
  finalIdempotencyRowsWritten:finalMerge?.json?.rowsWrittenThisRun ?? null,
  protectedProductionUnchanged:finalIdempotent,
  firstMergeManagementEditsPreserved:firstMerge?.json?.managementEditsPreserved ?? null,
  firstMergeRowsWritten:firstMerge?.json?.rowsWrittenThisRun ?? null,
  restoreMergeRowsWritten:restoreMerge?.json?.rowsWrittenThisRun ?? null,
  beforeProtected,
  touchedV4Stores:false,
  touchedV4Poe:false,
  touchedV4Photos:false,
  touchedDrive:false,
  touchedPhotoWorker:false,
  deletes:0
};
console.log(JSON.stringify(result,null,2));
if(failure)throw failure;
if(!result.ok)throw new Error('Controlled management-edit preservation test did not pass all gates.');
