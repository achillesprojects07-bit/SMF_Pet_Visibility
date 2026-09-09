#!/usr/bin/env node

/**
 * Live Field Runtime Verification — READ ONLY / FAIL CLOSED.
 *
 * Exercises the currently deployed Field API using a real active FIELD account,
 * compares getFieldHomeV4/getStoreV4 results to live V4_STORES, and NEVER writes.
 *
 * Important: Direct Active=FALSE containment is certified only if the live
 * workbook contains at least one inactive store that can be observed as hidden.
 * If there are no inactive rows, this verifier reports NOT DIRECTLY PROVEN and
 * keeps production APPLY locked.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const INTERNAL_SHEET_ID=process.env.GOOGLE_SHEET_ID||'1TNrb3ir8vS6CyZ8kXhRH43JXoH4Ws7iQ4g3649KQTf0';
const API_BASE_URL=String(process.env.FIELD_API_BASE_URL||'https://smf-pet-visibility-api.achilles-projects07.workers.dev').replace(/\/$/,'');
const OUT_DIR=process.env.LIVE_FIELD_VERIFY_OUT_DIR||'migration/live-field-runtime-output';
const MODE='LIVE_RUNTIME_READ_ONLY_VERIFY';
const WRITE_ACTIONS=new Set(['saveStoreV4','submitStoreVisitV4','submitDayV4','removePhotoV4','rescheduleStoreV4','reopenStoreVisitV4','createUserV4','setUserActiveV4','setUserTeamV4','resetUserCodeV4','setStoreGuideV4','setCategoryGuideV4','createOrResetClientAccessV4']);

function text(v){return String(v??'').trim();}
function truth(v){return v===true||String(v).toUpperCase()==='TRUE'||String(v)==='1';}
function hash(v){return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');}
function rowsToObjects(values){if(!values?.length)return[];const h=values[0].map(text);return values.slice(1).filter(r=>r.some(v=>text(v)!=='')).map((r,i)=>{const o={__row:i+2};h.forEach((k,j)=>{if(k)o[k]=r[j]??'';});return o;});}

async function oauthToken(){
  const need=n=>{const v=text(process.env[n]);if(!v)throw new Error(`Missing ${n}`);return v;};
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:need('GOOGLE_OAUTH_CLIENT_ID'),client_secret:need('GOOGLE_OAUTH_CLIENT_SECRET'),refresh_token:need('GOOGLE_OAUTH_REFRESH_TOKEN'),grant_type:'refresh_token'})});
  const d=await r.json();if(!r.ok||!d.access_token)throw new Error(`OAuth refresh failed: ${r.status}`);return d.access_token;
}
async function getRange(tok,range){
  const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(INTERNAL_SHEET_ID)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;
  const r=await fetch(u,{headers:{authorization:`Bearer ${tok}`}});if(!r.ok)throw new Error(`GET ${range} failed: ${r.status}`);return(await r.json()).values||[];
}
async function api(action,args=[]){
  if(WRITE_ACTIONS.has(action))throw new Error(`WRITE ACTION FORBIDDEN IN LIVE VERIFIER: ${action}`);
  const r=await fetch(`${API_BASE_URL}/api/action`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,args})});
  let d={};try{d=await r.json();}catch{throw new Error(`${action} returned unreadable response (${r.status})`);}
  if(!r.ok||d?.ok===false)throw new Error(d?.error||`${action} failed (${r.status})`);
  return Object.prototype.hasOwnProperty.call(d,'result')?d.result:d;
}

function selfTest(){
  const rows=[{'Store Key':'a','Assigned Team':'Team 1','Active':'TRUE'},{'Store Key':'b','Assigned Team':'Team 1','Active':'FALSE'}];
  const returned=[{key:'a'}];
  const inactive=rows.filter(r=>!truth(r.Active));
  const hidden=inactive.every(r=>!returned.some(x=>text(x.key)===text(r['Store Key'])));
  const tests={inactiveDetected:inactive.length===1,hiddenDetected:hidden,writeActionsBlocked:WRITE_ACTIONS.has('saveStoreV4'),readActionAllowed:!WRITE_ACTIONS.has('getFieldHomeV4')};
  if(Object.values(tests).some(v=>v!==true))throw new Error('SELF TEST FAILED '+JSON.stringify(tests));
  return {ok:true,tests};
}

if(process.argv.includes('--self-test')){
  console.log(JSON.stringify(selfTest(),null,2));
}else{
  const tok=await oauthToken();
  const [userValues,storeValues]=await Promise.all([getRange(tok,'V4_USERS!A1:H200'),getRange(tok,'V4_STORES!A1:R1000')]);
  const users=rowsToObjects(userValues),stores=rowsToObjects(storeValues);
  const fieldUser=users.find(u=>String(u.Role||'').toUpperCase()==='FIELD'&&truth(u.Active)&&text(u['Access Code']));
  if(!fieldUser)throw new Error('No active FIELD account available for read-only verification.');
  const code=text(fieldUser['Access Code']),team=text(fieldUser['Assigned Team']);

  const login=await api('loginV4',[code]);
  const loginRole=String(login?.user?.role||'').toUpperCase();
  const loginTeam=text(login?.user?.team||login?.user?.assignedTeam||team);
  if(loginRole!=='FIELD')throw new Error('Live login did not resolve to FIELD.');

  const home=await api('getFieldHomeV4',[code]);
  const returned=Array.isArray(home?.stores)?home.stores:[];
  const activeTeam=stores.filter(s=>truth(s.Active)&&text(s['Assigned Team'])===team);
  const inactiveTeam=stores.filter(s=>!truth(s.Active)&&text(s['Assigned Team'])===team);
  const returnedKeys=new Set(returned.map(s=>text(s.key||s.storeKey||s['Store Key'])));
  const activeKeys=new Set(activeTeam.map(s=>text(s['Store Key'])));

  const unexpectedReturned=[...returnedKeys].filter(k=>k&&!activeKeys.has(k));
  const missingActive=[...activeKeys].filter(k=>k&&!returnedKeys.has(k));
  const inactiveReturned=inactiveTeam.filter(s=>returnedKeys.has(text(s['Store Key']))).map(s=>({storeId:text(s['Store ID']),storeKey:text(s['Store Key'])}));

  let knownStoreOpen=false;
  const knownKey=returned.find(s=>text(s.key||s.storeKey||s['Store Key']))?.key||returned.find(s=>text(s.storeKey))?.storeKey||returned.find(s=>text(s['Store Key']))?.['Store Key']||'';
  if(knownKey){const detail=await api('getStoreV4',[code,knownKey]);knownStoreOpen=!!detail;}

  let unknownStoreRejected=false;
  try{await api('getStoreV4',[code,'__SMF_LIVE_VERIFY_NONEXISTENT_STORE_KEY__']);}
  catch{unknownStoreRejected=true;}

  const directActiveFalseSemanticsProven=inactiveTeam.length>0&&inactiveReturned.length===0;
  const invariants={
    readOnly:true,
    noWriteActionsInvoked:true,
    liveApiReached:true,
    fieldLoginConfirmed:loginRole==='FIELD',
    teamConsistent:!loginTeam||loginTeam===team,
    noUnexpectedStoresReturned:unexpectedReturned.length===0,
    allActiveTeamStoresReturned:missingActive.length===0,
    knownStoreCanOpen:returned.length===0?true:knownStoreOpen,
    unknownStoreRejected,
    inactiveStoreNotReturned:inactiveReturned.length===0
  };
  const certification={
    activeFalseSemanticsDirectlyProven:directActiveFalseSemanticsProven,
    reason:directActiveFalseSemanticsProven?'At least one live inactive store exists and none were returned by deployed Field home.':'No live Active=FALSE store is available for a zero-write direct containment test.',
    productionApplyUnlockAllowed:false,
    executorMustRemainHardLocked:true
  };
  const report={generatedAt:new Date().toISOString(),mode:MODE,apiBaseUrl:API_BASE_URL,fieldAccount:{displayName:text(fieldUser['Display Name']),team},counts:{liveStores:stores.length,activeTeamStores:activeTeam.length,inactiveTeamStores:inactiveTeam.length,returnedStores:returned.length},unexpectedReturned,missingActive,inactiveReturned,invariants,certification,fingerprint:hash({stores:stores.map(s=>({'Store ID':s['Store ID'],'Store Key':s['Store Key'],'Assigned Team':s['Assigned Team'],Active:s.Active})),returned:[...returnedKeys].sort()})};
  fs.mkdirSync(OUT_DIR,{recursive:true});fs.writeFileSync(`${OUT_DIR}/live-field-runtime-verification.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({mode:MODE,counts:report.counts,invariants,certification,fingerprint:report.fingerprint},null,2));
  if(Object.values(invariants).some(v=>v!==true))process.exitCode=2;
}
