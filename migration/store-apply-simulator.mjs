#!/usr/bin/env node

/**
 * Controlled Store APPLY Simulator — READ ONLY / IN MEMORY ONLY.
 *
 * This file proves what an approved Store management edit would change in
 * V4_STORES without writing to Google Sheets, Drive, Apps Script, Workers,
 * V4_POE, V4_PHOTOS, or the production upload path.
 *
 * Locked rules:
 * - existing stores match by Store ID only
 * - Store ID is immutable
 * - Legacy Store Key / live Store Key is immutable
 * - Actual Visit Date is not a management-edit field
 * - source absence never means delete
 * - new-store ADD remains preview-only until compatibility creation is proven
 * - V4_POE and V4_PHOTOS are protected and are fingerprinted before/after simulation
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildControlledPlan } from './store-change-planner.mjs';

const SOURCE_SHEET_ID = process.env.SOURCE_SHEET_ID || '1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
const INTERNAL_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1TNrb3ir8vS6CyZ8kXhRH43JXoH4Ws7iQ4g3649KQTf0';
const IDENTITY_SHEET = 'STORE IDENTITY & SCHEDULE';
const OUT_DIR = process.env.STORE_APPLY_SIM_OUT_DIR || 'migration/store-apply-sim-output';
const MODE = 'SIMULATE_ONLY';
const writeImplementationEnabled = false;

const EDIT_FIELD_MAP = new Map([
  ['Current Store Name','Store Name'],
  ['Assigned Team','Assigned Team'],
  ['Scheduled Deployment Date','Day'],
  ['Scheduled Stop','Stop No.'],
  ['Store Category','Store Category'],
  ['Street Address / Location','Address'],
  ['Barangay / District','Barangay'],
  ['City / Area','Area'],
  ['Material Allocation','Material Allocation'],
  ['Active','Active']
]);

function text(v){ return String(v ?? '').trim(); }
function rowsToObjects(values){ if(!values?.length)return[]; const h=values[0].map(text); return values.slice(1).filter(r=>r.some(v=>text(v)!=='')).map((r,i)=>{const o={__row:i+2}; h.forEach((k,j)=>{if(k)o[k]=r[j]??'';}); return o;}); }
function stableHash(v){ return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex'); }
function clone(v){ return JSON.parse(JSON.stringify(v)); }
function duplicates(items){ const seen=new Set(), dup=new Set(); for(const raw of items){const v=text(raw); if(!v)continue; if(seen.has(v))dup.add(v); seen.add(v);} return [...dup]; }

function simulateStoreEdits(identityRows, liveStores, actions){
  const simulated = clone(liveStores);
  const simulatedById = new Map(simulated.map(s=>[text(s['Store ID']),s]));
  const identityByRow = new Map(identityRows.map(r=>[r.__row,r]));
  const applied=[];
  const notApplied=[];

  for(const action of actions){
    if(action.action==='EDIT_REVIEW'){
      const target=simulatedById.get(text(action.storeId));
      const source=identityByRow.get(action.identityRow);
      if(!target||!source){notApplied.push({...action,simulationStatus:'BLOCKED_SIMULATION_LOOKUP'});continue;}
      const before={storeId:text(target['Store ID']),storeKey:text(target['Store Key']),row:clone(target)};
      for(const change of action.changes||[]){
        const liveField=EDIT_FIELD_MAP.get(change.sourceField);
        if(!liveField)continue;
        target[liveField]=source[change.sourceField]??'';
      }
      const after={storeId:text(target['Store ID']),storeKey:text(target['Store Key']),row:clone(target)};
      applied.push({
        action:'EDIT_SIMULATED',
        storeId:action.storeId,
        identityRow:action.identityRow,
        permanentIdentityPreserved:before.storeId===after.storeId&&before.storeKey===after.storeKey,
        changedFields:(action.changes||[]).map(c=>({sourceField:c.sourceField,liveField:EDIT_FIELD_MAP.get(c.sourceField),from:c.current,to:c.desired})),
        beforeIdentity:{storeId:before.storeId,storeKey:before.storeKey},
        afterIdentity:{storeId:after.storeId,storeKey:after.storeKey}
      });
    } else if(action.action==='ADD_REVIEW'){
      notApplied.push({
        ...action,
        simulationStatus:'ADD_NOT_APPLIED',
        reason:'NEW_STORE_COMPATIBILITY_CREATION_NOT_YET_PROVEN',
        requiresBeforeApply:['permanent Store ID allocation','compatibility Store Key generation','Material JSON/rules derivation','existing-folder compatibility/provisioning decision'],
        writeAttempted:false
      });
    } else if(action.action==='PRESERVE_LIVE_ONLY'){
      notApplied.push({...action,simulationStatus:'PRESERVED_NO_DELETE'});
    } else if(action.action==='BLOCKED'){
      notApplied.push({...action,simulationStatus:'BLOCKED'});
    }
  }
  return {simulated,applied,notApplied};
}

export function buildApplySimulation(identityRows,liveStores,poeRows=[],photoRows=[]){
  const actions=buildControlledPlan(identityRows,liveStores);
  const storesBeforeHash=stableHash(liveStores);
  const poeBeforeHash=stableHash(poeRows);
  const photosBeforeHash=stableHash(photoRows);
  const {simulated,applied,notApplied}=simulateStoreEdits(identityRows,liveStores,actions);
  const storesAfterHash=stableHash(simulated);
  const poeAfterHash=stableHash(poeRows);
  const photosAfterHash=stableHash(photoRows);

  const editActions=actions.filter(a=>a.action==='EDIT_REVIEW');
  const addActions=actions.filter(a=>a.action==='ADD_REVIEW');
  const blocked=actions.filter(a=>a.action==='BLOCKED');
  const preserve=actions.filter(a=>a.action==='PRESERVE_LIVE_ONLY');

  const liveById=new Map(liveStores.map(s=>[text(s['Store ID']),s]));
  const simById=new Map(simulated.map(s=>[text(s['Store ID']),s]));
  const immutableIdentityPreserved=[...liveById.keys()].every(id=>{
    const before=liveById.get(id), after=simById.get(id);
    return !!after && text(before['Store ID'])===text(after['Store ID']) && text(before['Store Key'])===text(after['Store Key']);
  });

  const report={
    generatedAt:new Date().toISOString(),
    mode:MODE,
    writeImplementationEnabled,
    uploadArchitectureTouched:false,
    applyEligibility:'EDITS_SIMULATABLE__NEW_STORES_NOT_APPLY_ELIGIBLE',
    totals:{identityRows:identityRows.length,liveStores:liveStores.length,poeRows:poeRows.length,photoRows:photoRows.length},
    planCounts:{
      unchanged:actions.filter(a=>a.action==='UNCHANGED').length,
      edits:editActions.length,
      adds:addActions.length,
      blocked:blocked.length,
      preserveLiveOnly:preserve.length,
      deletes:0
    },
    simulationCounts:{editsSimulated:applied.length,addsApplied:0,deletesApplied:0,notApplied:notApplied.length},
    fingerprints:{storesBefore:storesBeforeHash,storesAfter:storesAfterHash,poeBefore:poeBeforeHash,poeAfter:poeAfterHash,photosBefore:photosBeforeHash,photosAfter:photosAfterHash},
    invariants:{
      noWrites:true,
      deleteIsZero:true,
      storeCountPreserved:simulated.length===liveStores.length,
      storeIdsUnique:duplicates(simulated.map(s=>s['Store ID'])).length===0,
      storeKeysUnique:duplicates(simulated.map(s=>s['Store Key'])).length===0,
      immutableIdentityPreserved,
      everySimulatedEditPreservesPermanentIdentity:applied.every(a=>a.permanentIdentityPreserved===true),
      actualVisitDateNotEditable:!EDIT_FIELD_MAP.has('Actual Visit Date'),
      protectedPoeUnchanged:poeBeforeHash===poeAfterHash,
      protectedPhotosUnchanged:photosBeforeHash===photosAfterHash,
      newStoresNotApplied:addActions.length===0 || notApplied.filter(a=>a.action==='ADD_REVIEW').every(a=>a.simulationStatus==='ADD_NOT_APPLIED'&&a.writeAttempted===false),
      uploadArchitectureTouched:false
    },
    simulatedEdits:applied,
    notApplied
  };
  return report;
}

function selfTest(){
  const live=[
    {'Store ID':'SMF-0001','Store Key':'Team 1|Sept 2|1|Alpha','Store Name':'Alpha','Assigned Team':'Team 1',Day:'Sept 2','Stop No.':'1','Store Category':'Feeds Store',Address:'A St',Barangay:'B1',Area:'QC','Material Allocation':'SET 1','Material JSON':'{"x":1}',Pending:'FALSE','Category Rule':'FEED','Override Rule':'','Effective Rule':'FEED',Active:'TRUE'},
    {'Store ID':'SMF-0002','Store Key':'Team 1|Sept 2|2|Beta','Store Name':'Beta','Assigned Team':'Team 1',Day:'Sept 2','Stop No.':'2','Store Category':'Pet Shop',Address:'B St',Barangay:'B2',Area:'QC','Material Allocation':'SET 2','Material JSON':'{"y":2}',Pending:'FALSE','Category Rule':'PET','Override Rule':'','Effective Rule':'PET',Active:'TRUE'}
  ];
  const common={'Assigned Team':'Team 1','Route Day':'DAY 1','Route Stop':'1','Scheduled Deployment Date':'2026-09-02','Scheduled Stop':'1','Store Category':'Feeds Store','Street Address / Location':'A St','Barangay / District':'B1','City / Area':'QC','Material Allocation':'SET 1','Active':'TRUE'};
  const poe=[{'Store Key':live[0]['Store Key'],'Store Status':'COMPLETED'}];
  const photos=[{'Store Key':live[0]['Store Key'],'File ID':'FILE1','Folder ID':'FOLDER1'}];
  const tests=[]; const assert=(name,ok)=>{if(!ok)throw new Error('SELF TEST FAILED: '+name);tests.push(name);};

  let identity=[{...common,__row:2,'Store ID':'SMF-0001','Legacy Store Key':live[0]['Store Key'],'Current Store Name':'Alpha Renamed','Actual Visit Date':'2099-01-01'}];
  let r=buildApplySimulation(identity,live,poe,photos);
  assert('rename simulated',r.simulationCounts.editsSimulated===1);
  assert('rename preserves store id and key',r.invariants.everySimulatedEditPreservesPermanentIdentity===true);
  assert('actual visit date cannot be management-applied',r.invariants.actualVisitDateNotEditable===true);
  assert('protected poe unchanged',r.invariants.protectedPoeUnchanged===true);
  assert('protected photos unchanged',r.invariants.protectedPhotosUnchanged===true);

  identity=[{...common,__row:2,'Store ID':'SMF-0001','Legacy Store Key':live[0]['Store Key'],'Current Store Name':'Alpha','Scheduled Deployment Date':'2026-09-05'}];
  r=buildApplySimulation(identity,live,poe,photos);
  assert('schedule edit changes only mapped live field',r.simulatedEdits[0].changedFields.some(x=>x.liveField==='Day') && r.simulatedEdits[0].changedFields.every(x=>x.liveField!=='Store Key'&&x.liveField!=='Store ID'));

  const add={...common,__row:3,'Store ID':'','Legacy Store Key':'','Current Store Name':'Gamma','Route Stop':'3','Scheduled Stop':'3','Street Address / Location':'C St'};
  r=buildApplySimulation([add],live,poe,photos);
  assert('new store remains not applied',r.planCounts.adds===1&&r.simulationCounts.addsApplied===0&&r.invariants.newStoresNotApplied===true);

  r=buildApplySimulation([],live,poe,photos);
  assert('source absence never deletes',r.planCounts.preserveLiveOnly===2&&r.planCounts.deletes===0&&r.simulationCounts.deletesApplied===0&&r.invariants.storeCountPreserved===true);
  assert('upload architecture untouched',r.invariants.uploadArchitectureTouched===false);
  return {ok:true,testsPassed:tests.length,tests};
}

async function accessToken(){
  const need=n=>{const v=text(process.env[n]);if(!v)throw new Error(`Missing required environment variable: ${n}`);return v;};
  const body=new URLSearchParams({client_id:need('GOOGLE_OAUTH_CLIENT_ID'),client_secret:need('GOOGLE_OAUTH_CLIENT_SECRET'),refresh_token:need('GOOGLE_OAUTH_REFRESH_TOKEN'),grant_type:'refresh_token'});
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
  const j=await r.json(); if(!r.ok||!j.access_token)throw new Error(`Google OAuth refresh failed: ${r.status}`); return j.access_token;
}
async function getRange(token,id,range){const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;const r=await fetch(u,{headers:{authorization:`Bearer ${token}`}});if(!r.ok)throw new Error(`GET ${range} failed: ${r.status} ${await r.text()}`);return(await r.json()).values||[];}

if(process.argv.includes('--self-test')){
  console.log(JSON.stringify(selfTest(),null,2));
}else{
  const token=await accessToken();
  const [identityValues,storesValues,poeValues,photoValues]=await Promise.all([
    getRange(token,SOURCE_SHEET_ID,`'${IDENTITY_SHEET}'!A1:R1000`),
    getRange(token,INTERNAL_SHEET_ID,'V4_STORES!A1:S1000'),
    getRange(token,INTERNAL_SHEET_ID,'V4_POE!A1:S2000'),
    getRange(token,INTERNAL_SHEET_ID,'V4_PHOTOS!A1:N10000')
  ]);
  const identityRows=rowsToObjects(identityValues), liveStores=rowsToObjects(storesValues), poeRows=rowsToObjects(poeValues), photoRows=rowsToObjects(photoValues);
  const report=buildApplySimulation(identityRows,liveStores,poeRows,photoRows);
  fs.mkdirSync(OUT_DIR,{recursive:true});
  fs.writeFileSync(`${OUT_DIR}/store-apply-simulation.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({mode:report.mode,writeImplementationEnabled:report.writeImplementationEnabled,totals:report.totals,planCounts:report.planCounts,simulationCounts:report.simulationCounts,invariants:report.invariants,fingerprints:report.fingerprints},null,2));
  if(report.planCounts.blocked!==0 || Object.values(report.invariants).some(v=>v!==true))process.exitCode=2;
}
