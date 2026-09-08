#!/usr/bin/env node

/**
 * Controlled Store Add/Edit Planner — READ ONLY.
 *
 * Purpose:
 * - plan management edits for existing stores by permanent Store ID only
 * - detect proposed new-store rows without assigning or writing IDs
 * - preserve Legacy Store Key for every existing store
 * - never interpret source absence as DELETE
 * - never write Google Sheets, Drive, Apps Script, Worker, V4_POE or V4_PHOTOS
 *
 * New-store convention for planning only:
 * - management may append a complete row to STORE IDENTITY & SCHEDULE
 * - Store ID must be blank
 * - Legacy Store Key must be blank
 * - planner proposes the next SMF-#### ID but DOES NOT write/reserve it
 * - actual creation remains disabled until a later, separately gated apply phase
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const SOURCE_SHEET_ID = process.env.SOURCE_SHEET_ID || '1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
const INTERNAL_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1TNrb3ir8vS6CyZ8kXhRH43JXoH4Ws7iQ4g3649KQTf0';
const IDENTITY_SHEET = 'STORE IDENTITY & SCHEDULE';
const OUT_DIR = process.env.STORE_CHANGE_OUT_DIR || 'migration/store-change-output';
const MODE = 'DRY_RUN';

const REQUIRED_IDENTITY_HEADERS = [
  'Store ID','Current Store Name','Assigned Team','Route Day','Route Stop',
  'Scheduled Deployment Date','Scheduled Stop','Store Category',
  'Street Address / Location','Barangay / District','City / Area',
  'Material Allocation','Active','Legacy Store Key'
];

const REQUIRED_NEW_STORE_FIELDS = [
  'Current Store Name','Assigned Team','Route Day','Route Stop',
  'Scheduled Deployment Date','Scheduled Stop','Store Category',
  'Street Address / Location','Barangay / District','City / Area',
  'Material Allocation','Active'
];

const EDIT_FIELD_MAP = [
  ['Current Store Name','Store Name','text'],
  ['Assigned Team','Assigned Team','team'],
  ['Scheduled Deployment Date','Day','date'],
  ['Scheduled Stop','Stop No.','text'],
  ['Store Category','Store Category','norm'],
  ['Street Address / Location','Address','norm'],
  ['Barangay / District','Barangay','norm'],
  ['City / Area','Area','norm'],
  ['Material Allocation','Material Allocation','norm'],
  ['Active','Active','bool']
];

function text(v){ return String(v ?? '').trim(); }
function norm(v){ return text(v).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' '); }
function teamNorm(v){ const m=text(v).match(/team\s*(\d+)/i); return m ? `Team ${m[1]}` : text(v); }
function boolNorm(v){ const s=text(v).toLowerCase(); return ['true','yes','1','active'].includes(s)?'TRUE':['false','no','0','inactive'].includes(s)?'FALSE':text(v).toUpperCase(); }
function dateNorm(v){ const s=text(v); if(!s)return''; let m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if(m)return s; m=s.match(/^Sept(?:ember)?\s+(\d{1,2})$/i); if(m)return `2026-09-${String(Number(m[1])).padStart(2,'0')}`; m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m?`${m[3]}-${String(Number(m[1])).padStart(2,'0')}-${String(Number(m[2])).padStart(2,'0')}`:s; }
function rowsToObjects(values){ if(!values?.length)return[]; const h=values[0].map(text); return values.slice(1).filter(r=>r.some(v=>text(v)!=='')).map((r,i)=>{const o={__row:i+2}; h.forEach((k,j)=>{if(k)o[k]=r[j]??'';}); return o;}); }
function duplicates(items){ const seen=new Set(), dup=new Set(); for(const raw of items){const v=text(raw); if(!v)continue; if(seen.has(v))dup.add(v); seen.add(v);} return [...dup]; }
function stableHash(v){ return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex'); }
function normalizeBy(kind,v){ if(kind==='team')return teamNorm(v); if(kind==='date')return dateNorm(v); if(kind==='norm')return norm(v); if(kind==='bool')return boolNorm(v); return text(v); }

function nextStoreId(liveStores, identityRows){
  const nums=[...liveStores,...identityRows].map(r=>text(r['Store ID'])).map(id=>{const m=id.match(/^SMF-(\d{4})$/);return m?Number(m[1]):0;});
  return `SMF-${String(Math.max(0,...nums)+1).padStart(4,'0')}`;
}

function compareExisting(identity, live){
  const changes=[];
  for(const [sourceField,liveField,kind] of EDIT_FIELD_MAP){
    const desired=identity[sourceField], current=live[liveField];
    if(normalizeBy(kind,desired)!==normalizeBy(kind,current)) changes.push({sourceField,liveField,current:text(current),desired:text(desired)});
  }
  return changes;
}

function duplicateRisk(row, liveStores, otherNewRows=[]){
  const name=norm(row['Current Store Name']);
  const address=norm(row['Street Address / Location']);
  const team=teamNorm(row['Assigned Team']);
  const candidates=[...liveStores.map(s=>({name:norm(s['Store Name']),address:norm(s.Address),team:teamNorm(s['Assigned Team']),storeId:text(s['Store ID'])})),...otherNewRows.map(r=>({name:norm(r['Current Store Name']),address:norm(r['Street Address / Location']),team:teamNorm(r['Assigned Team']),storeId:''}))];
  return candidates.filter(c=> (name&&c.name===name) || (address&&c.address===address&&team===c.team));
}

export function buildControlledPlan(identityRows, liveStores){
  const liveById=new Map();
  for(const s of liveStores){const id=text(s['Store ID']); if(id&&!liveById.has(id))liveById.set(id,s);}
  const duplicateIdentityIds=new Set(duplicates(identityRows.map(r=>r['Store ID'])));
  const matchedLiveIds=new Set();
  const actions=[];
  const candidateNewRows=[];
  let proposedId=nextStoreId(liveStores, identityRows);
  let proposedNumber=Number(proposedId.slice(4));

  for(const row of identityRows){
    const storeId=text(row['Store ID']);
    const legacyKey=text(row['Legacy Store Key']);

    if(!storeId){
      const missing=REQUIRED_NEW_STORE_FIELDS.filter(f=>!text(row[f]));
      const risk=duplicateRisk(row,liveStores,candidateNewRows);
      if(legacyKey){
        actions.push({action:'BLOCKED',reason:'NEW_STORE_ROW_MUST_NOT_PREASSIGN_LEGACY_KEY',identityRow:row.__row,currentName:text(row['Current Store Name']),legacyStoreKey:legacyKey});
      }else if(missing.length){
        actions.push({action:'BLOCKED',reason:'NEW_STORE_REQUIRED_FIELDS_MISSING',identityRow:row.__row,currentName:text(row['Current Store Name']),missingFields:missing});
      }else if(risk.length){
        actions.push({action:'BLOCKED',reason:'POSSIBLE_DUPLICATE_NEW_STORE',identityRow:row.__row,currentName:text(row['Current Store Name']),duplicateCandidates:risk});
      }else{
        const candidate=`SMF-${String(proposedNumber++).padStart(4,'0')}`;
        actions.push({action:'ADD_REVIEW',reason:'CONTROLLED_NEW_STORE_CANDIDATE',identityRow:row.__row,proposedStoreId:candidate,storeIdWritten:false,legacyStoreKeyWritten:false,currentName:text(row['Current Store Name']),team:teamNorm(row['Assigned Team']),routeDay:text(row['Route Day']),routeStop:text(row['Route Stop']),scheduledDate:dateNorm(row['Scheduled Deployment Date']),scheduledStop:text(row['Scheduled Stop']),storeCategory:text(row['Store Category']),address:text(row['Street Address / Location']),barangay:text(row['Barangay / District']),area:text(row['City / Area']),materialAllocation:text(row['Material Allocation']),active:boolNorm(row.Active)});
        candidateNewRows.push(row);
      }
      continue;
    }

    if(duplicateIdentityIds.has(storeId)){
      actions.push({action:'BLOCKED',reason:'DUPLICATE_STORE_ID_IN_IDENTITY_LAYER',storeId,identityRow:row.__row,currentName:text(row['Current Store Name'])});
      continue;
    }
    const live=liveById.get(storeId);
    if(!live){
      actions.push({action:'BLOCKED',reason:'UNKNOWN_PREASSIGNED_STORE_ID_REQUIRES_SEPARATE_ADD_APPROVAL',storeId,identityRow:row.__row,currentName:text(row['Current Store Name'])});
      continue;
    }
    matchedLiveIds.add(storeId);
    const liveKey=text(live['Store Key']);
    if(!legacyKey || legacyKey!==liveKey){
      actions.push({action:'BLOCKED',reason:!legacyKey?'EXISTING_STORE_LEGACY_KEY_BLANK':'LEGACY_STORE_KEY_MISMATCH_IMMUTABLE',storeId,identityRow:row.__row,currentName:text(row['Current Store Name']),identityLegacyStoreKey:legacyKey,liveLegacyStoreKey:liveKey});
      continue;
    }
    const changes=compareExisting(row,live);
    actions.push({action:changes.length?'EDIT_REVIEW':'UNCHANGED',storeId,legacyStoreKey:legacyKey,identityRow:row.__row,currentName:text(row['Current Store Name']),matchMethod:'STORE_ID_ONLY',changes,storeIdWillChange:false,legacyStoreKeyWillChange:false});
  }

  for(const live of liveStores){
    const id=text(live['Store ID']);
    if(id&&!matchedLiveIds.has(id)) actions.push({action:'PRESERVE_LIVE_ONLY',reason:'SOURCE_ABSENCE_NEVER_MEANS_DELETE',storeId:id,legacyStoreKey:text(live['Store Key']),currentLiveName:text(live['Store Name'])});
  }
  return actions;
}

function summarize(actions){
  const counts={UNCHANGED:0,EDIT_REVIEW:0,ADD_REVIEW:0,BLOCKED:0,PRESERVE_LIVE_ONLY:0,DELETE:0};
  for(const a of actions) if(Object.prototype.hasOwnProperty.call(counts,a.action)) counts[a.action]++;
  return counts;
}

function runSelfTest(){
  const live=[
    {'Store ID':'SMF-0001','Store Key':'Team 1|Sept 2|1|Alpha','Store Name':'Alpha','Assigned Team':'Team 1',Day:'Sept 2','Stop No.':'1','Store Category':'Feeds Store',Address:'A St',Barangay:'B1',Area:'QC','Material Allocation':'SET 1',Active:'TRUE'},
    {'Store ID':'SMF-0002','Store Key':'Team 1|Sept 2|2|Beta','Store Name':'Beta','Assigned Team':'Team 1',Day:'Sept 2','Stop No.':'2','Store Category':'Pet Shop',Address:'B St',Barangay:'B2',Area:'QC','Material Allocation':'SET 2',Active:'TRUE'}
  ];
  const base={'Assigned Team':'Team 1','Route Day':'DAY 1','Route Stop':'1','Scheduled Deployment Date':'2026-09-02','Scheduled Stop':'1','Store Category':'Feeds Store','Street Address / Location':'A St','Barangay / District':'B1','City / Area':'QC','Material Allocation':'SET 1','Active':'TRUE'};
  const tests=[];
  const assert=(name,condition)=>{if(!condition)throw new Error(`SELF TEST FAILED: ${name}`);tests.push(name);};

  let p=buildControlledPlan([{...base,'Store ID':'SMF-0001','Current Store Name':'Alpha Renamed','Legacy Store Key':live[0]['Store Key']}],live);
  assert('existing rename is edit review',p.some(x=>x.action==='EDIT_REVIEW'&&x.storeId==='SMF-0001'&&x.changes.some(c=>c.sourceField==='Current Store Name')));
  assert('existing edit preserves permanent identity',p.find(x=>x.storeId==='SMF-0001').storeIdWillChange===false&&p.find(x=>x.storeId==='SMF-0001').legacyStoreKeyWillChange===false);

  const add={...base,'Store ID':'','Legacy Store Key':'','Current Store Name':'Gamma','Route Stop':'3','Scheduled Stop':'3','Street Address / Location':'C St'};
  p=buildControlledPlan([add],live);
  assert('complete blank-id row becomes add review',p.some(x=>x.action==='ADD_REVIEW'&&x.proposedStoreId==='SMF-0003'&&x.storeIdWritten===false));

  p=buildControlledPlan([{...add,'Current Store Name':''}],live);
  assert('incomplete new store is blocked',p.some(x=>x.action==='BLOCKED'&&x.reason==='NEW_STORE_REQUIRED_FIELDS_MISSING'));

  p=buildControlledPlan([{...base,'Store ID':'SMF-0001','Current Store Name':'Alpha','Legacy Store Key':'WRONG'}],live);
  assert('legacy key mismatch is blocked',p.some(x=>x.action==='BLOCKED'&&x.reason==='LEGACY_STORE_KEY_MISMATCH_IMMUTABLE'));

  p=buildControlledPlan([{...add,'Current Store Name':'Alpha','Street Address / Location':'New Address'}],live);
  assert('duplicate new store is blocked',p.some(x=>x.action==='BLOCKED'&&x.reason==='POSSIBLE_DUPLICATE_NEW_STORE'));

  p=buildControlledPlan([],live);
  assert('source absence preserves live stores',p.filter(x=>x.action==='PRESERVE_LIVE_ONLY').length===2);
  assert('delete is impossible',summarize(p).DELETE===0);
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
  console.log(JSON.stringify(runSelfTest(),null,2));
}else{
  const token=await accessToken();
  const [identityValues,liveValues]=await Promise.all([
    getRange(token,SOURCE_SHEET_ID,`'${IDENTITY_SHEET}'!A1:R1000`),
    getRange(token,INTERNAL_SHEET_ID,'V4_STORES!A1:S1000')
  ]);
  const identityHeaders=(identityValues[0]||[]).map(text);
  const missingHeaders=REQUIRED_IDENTITY_HEADERS.filter(h=>!identityHeaders.includes(h));
  if(missingHeaders.length)throw new Error(`Identity layer missing required headers: ${missingHeaders.join(', ')}`);
  const identityRows=rowsToObjects(identityValues), liveStores=rowsToObjects(liveValues);
  const actions=buildControlledPlan(identityRows,liveStores), counts=summarize(actions);
  const invariants={
    liveStoreIdsUnique:duplicates(liveStores.map(r=>r['Store ID'])).length===0,
    liveStoreKeysUnique:duplicates(liveStores.map(r=>r['Store Key'])).length===0,
    noBlankLiveStoreIds:liveStores.every(r=>text(r['Store ID'])),
    noBlankLiveStoreKeys:liveStores.every(r=>text(r['Store Key'])),
    existingMatchesByStoreIdOnly:actions.filter(a=>a.action==='UNCHANGED'||a.action==='EDIT_REVIEW').every(a=>a.matchMethod==='STORE_ID_ONLY'),
    existingStoreIdsImmutable:actions.filter(a=>a.action==='UNCHANGED'||a.action==='EDIT_REVIEW').every(a=>a.storeIdWillChange===false),
    existingLegacyKeysImmutable:actions.filter(a=>a.action==='UNCHANGED'||a.action==='EDIT_REVIEW').every(a=>a.legacyStoreKeyWillChange===false),
    deleteAlwaysZero:counts.DELETE===0,
    writesEnabled:false
  };
  const fingerprint=stableHash({identity:identityRows,live:liveStores});
  const report={generatedAt:new Date().toISOString(),mode:MODE,writeImplementationEnabled:false,identitySource:IDENTITY_SHEET,matchingPolicy:'EXISTING_BY_STORE_ID_ONLY',newStorePolicy:'BLANK_ID_REVIEW_THEN_SEPARATE_APPROVAL',counts,invariants,fingerprint,actions};
  fs.mkdirSync(OUT_DIR,{recursive:true});
  fs.writeFileSync(`${OUT_DIR}/store-change-plan.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({mode:MODE,writeImplementationEnabled:false,identityRows:identityRows.length,liveStores:liveStores.length,counts,invariants,fingerprint},null,2));
  if(counts.BLOCKED||Object.values(invariants).some(v=>v!==true&&v!==false))process.exitCode=2;
}
