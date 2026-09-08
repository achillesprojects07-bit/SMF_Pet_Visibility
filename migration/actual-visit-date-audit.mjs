#!/usr/bin/env node

/**
 * Read-only Actual Visit Date evidence audit.
 *
 * Purpose:
 * - determine which LIVE V4_POE records prove a physical field visit
 * - distinguish actual visits from submitted outcomes that explicitly say the store was not visited
 * - flag ambiguous zero-install outcomes for human review
 * - compare the conservative proposed Actual Visit Date against STORE IDENTITY & SCHEDULE
 *
 * Safety contract:
 * - GET requests only
 * - never writes source or internal Sheets
 * - never writes Drive, Apps Script, Cloudflare, V4_STORES, V4_POE or V4_PHOTOS
 * - never deletes anything
 */

import fs from 'node:fs';
import path from 'node:path';

const SOURCE_SHEET_ID = process.env.SOURCE_SHEET_ID || '1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
const INTERNAL_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1TNrb3ir8vS6CyZ8kXhRH43JXoH4Ws7iQ4g3649KQTf0';
const IDENTITY_SHEET = 'STORE IDENTITY & SCHEDULE';
const EXPECTED_BASELINE_COUNT = 83;
const OUT_DIR = 'migration/actual-visit-audit-output';

function need(name){const v=String(process.env[name]||'').trim();if(!v)throw new Error(`Missing required environment variable: ${name}`);return v;}
function text(v){return String(v??'').trim();}
function upper(v){return text(v).toUpperCase();}
function rowsToObjects(values){if(!values?.length)return[];const h=values[0].map(text);return values.slice(1).filter(r=>r.some(v=>text(v)!=='')).map((r,i)=>{const o={__row:i+2};h.forEach((k,j)=>{if(k)o[k]=r[j]??'';});return o;});}
function unique(arr){return new Set(arr).size===arr.length;}
function dateOnly(v){const s=text(v);if(!s)return'';let m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);if(m)return`${m[3]}-${String(Number(m[1])).padStart(2,'0')}-${String(Number(m[2])).padStart(2,'0')}`;m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);return m?`${m[1]}-${m[2]}-${m[3]}`:'';}
function dateRank(v){const d=dateOnly(v);return d?Date.parse(`${d}T00:00:00Z`):0;}
function parseJson(v){try{const x=JSON.parse(text(v)||'{}');return x&&typeof x==='object'?x:{};}catch{return{};}}
function numericTotal(obj){let n=0;for(const v of Object.values(obj||{})){if(v&&typeof v==='object')n+=numericTotal(v);else{const x=Number(v);if(Number.isFinite(x)&&x>0)n+=x;}}return n;}
function compactNote(v){return text(v).replace(/\s+/g,' ');}

const NO_VISIT_PATTERNS = [
  /hindi\s+na\s+(?:din\s+)?(?:po\s+)?(?:namin\s+)?pinuntahan/i,
  /di\s+na\s+(?:din\s+)?(?:po\s+)?(?:namin\s+)?pinuntahan/i,
  /hindi\s+(?:na\s+)?(?:po\s+)?pinuntahan/i,
  /sinabe.*agent.*hindi.*pinuntahan/i,
  /sinabi.*agent.*hindi.*pinuntahan/i
];
const ONSITE_PATTERNS = [
  /pinuntahan/i,
  /dinaanan/i,
  /pag\s*punta/i,
  /nag\s*punta/i,
  /nagpunta/i,
  /pag\s*dating/i,
  /pagdating/i,
  /store\s+was\s+closed/i
];
function hasAny(s,patterns){return patterns.some(re=>re.test(s));}

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

const token=await accessToken();
const [identityValues,poeValues]=await Promise.all([
  getRange(token,SOURCE_SHEET_ID,`'${IDENTITY_SHEET}'!A1:R500`),
  getRange(token,INTERNAL_SHEET_ID,'V4_POE!A1:S2500')
]);
const identity=rowsToObjects(identityValues);
const poe=rowsToObjects(poeValues).filter(r=>upper(r.Environment)==='LIVE');
if(identity.length!==EXPECTED_BASELINE_COUNT)throw new Error(`Identity row count ${identity.length}; expected ${EXPECTED_BASELINE_COUNT}.`);
const ids=identity.map(r=>text(r['Store ID']));
const keys=identity.map(r=>text(r['Legacy Store Key']));
if(ids.some(v=>!v)||!unique(ids))throw new Error('Identity Store IDs blank/duplicated.');
if(keys.some(v=>!v)||!unique(keys))throw new Error('Identity Legacy Store Keys blank/duplicated.');
const byKey=new Map(identity.map(r=>[text(r['Legacy Store Key']),r]));
const unresolvedPoeKeys=[...new Set(poe.map(r=>text(r['Store Key'])).filter(k=>k&&!byKey.has(k)))];
if(unresolvedPoeKeys.length)throw new Error(`LIVE V4_POE contains unresolved Store Keys: ${unresolvedPoeKeys.join(', ')}`);

function classifySubmission(r){
  const completedAt=text(r['Completed At']);
  const status=upper(r['Store Status']);
  const note=compactNote(r.Notes);
  const installedTotal=numericTotal(parseJson(r['Installed JSON']));
  const explicitNoVisit=hasAny(note,NO_VISIT_PATTERNS);
  const explicitOnsite=hasAny(note,ONSITE_PATTERNS) && !explicitNoVisit;
  if(!completedAt)return{classification:'NOT_FINAL_SUBMISSION',confirmedVisit:false,completedAt:'',visitDate:'',status,installedTotal,note,reason:'Completed At is blank'};
  if(explicitNoVisit)return{classification:'NO_VISIT_DECLARED',confirmedVisit:false,completedAt,visitDate:'',status,installedTotal,note,reason:'Field note explicitly states the store was not visited'};
  if(installedTotal>0)return{classification:'VISIT_CONFIRMED_INSTALL',confirmedVisit:true,completedAt,visitDate:dateOnly(completedAt),status,installedTotal,note,reason:'Positive installed quantity proves onsite handling'};
  if(explicitOnsite)return{classification:'VISIT_CONFIRMED_NOTE',confirmedVisit:true,completedAt,visitDate:dateOnly(completedAt),status,installedTotal,note,reason:'Field note explicitly indicates physical presence'};
  return{classification:'AMBIGUOUS_FINAL_OUTCOME',confirmedVisit:false,completedAt,visitDate:'',status,installedTotal,note,reason:'Final outcome exists but zero installation and no explicit onsite/no-visit evidence'};
}

const poeByKey=new Map();
for(const r of poe){const k=text(r['Store Key']);if(!k)continue;if(!poeByKey.has(k))poeByKey.set(k,[]);poeByKey.get(k).push(r);}

const details=[];
for(const idRow of identity){
  const storeId=text(idRow['Store ID']);
  const key=text(idRow['Legacy Store Key']);
  const submissions=(poeByKey.get(key)||[]).map(r=>({...classifySubmission(r),updatedAt:text(r['Updated At']),completedBy:text(r['Completed By'])}));
  const confirmed=submissions.filter(x=>x.confirmedVisit&&x.visitDate).sort((a,b)=>dateRank(a.visitDate)-dateRank(b.visitDate));
  const noVisit=submissions.filter(x=>x.classification==='NO_VISIT_DECLARED');
  const ambiguous=submissions.filter(x=>x.classification==='AMBIGUOUS_FINAL_OUTCOME');
  const proposed=confirmed[0]?.visitDate||'';
  let evidenceClass='NO_FIELD_SUBMISSION';
  if(confirmed.length)evidenceClass='VISIT_CONFIRMED';
  else if(noVisit.length&&ambiguous.length===0)evidenceClass='NO_VISIT_DECLARED';
  else if(ambiguous.length)evidenceClass='REVIEW_REQUIRED';
  else if(submissions.length)evidenceClass='NO_FINAL_OUTCOME';
  const current=dateOnly(idRow['Actual Visit Date']);
  details.push({
    storeId,
    storeName:text(idRow['Current Store Name']),
    legacyStoreKey:key,
    scheduledDeploymentDate:text(idRow['Scheduled Deployment Date']),
    currentActualVisitDate:current,
    proposedActualVisitDate:proposed,
    evidenceClass,
    changeNeeded:current!==proposed,
    submissions
  });
}

const statusCounts={};for(const r of poe){const s=upper(r['Store Status'])||'(BLANK)';statusCounts[s]=(statusCounts[s]||0)+1;}
const evidenceCounts={};for(const d of details)evidenceCounts[d.evidenceClass]=(evidenceCounts[d.evidenceClass]||0)+1;
const changed=details.filter(d=>d.changeNeeded);
const currentPopulated=details.filter(d=>d.currentActualVisitDate).length;
const proposedPopulated=details.filter(d=>d.proposedActualVisitDate).length;
const noVisitStores=details.filter(d=>d.evidenceClass==='NO_VISIT_DECLARED');
const reviewStores=details.filter(d=>d.evidenceClass==='REVIEW_REQUIRED');

const summary={
  ok:true,
  policy:'CONSERVATIVE_PHYSICAL_VISIT_EVIDENCE',
  rule:[
    'Use earliest confirmed physical visit date, not latest submission date.',
    'Positive Installed JSON quantity is direct evidence of an onsite visit.',
    'Explicit onsite wording in field notes can confirm a visit when installed quantity is zero.',
    'Explicit wording that the store was not visited overrides a submitted REFUSED/CLOSED/INCOMPLETE outcome and leaves Actual Visit Date blank.',
    'A final outcome with zero installation and no explicit onsite/no-visit evidence is REVIEW_REQUIRED and does not receive an Actual Visit Date automatically.',
    'OPEN rows with blank Completed At are not treated as an Actual Visit Date.'
  ],
  identityRows:identity.length,
  livePoeRows:poe.length,
  statusCounts,
  evidenceCounts,
  currentActualVisitDatesPopulated:currentPopulated,
  proposedActualVisitDatesPopulated:proposedPopulated,
  rowsWhoseCurrentActualVisitDateWouldChange:changed.length,
  noVisitDeclaredStores:noVisitStores.map(d=>({storeId:d.storeId,storeName:d.storeName,current:d.currentActualVisitDate,proposed:d.proposedActualVisitDate,notes:d.submissions.filter(s=>s.classification==='NO_VISIT_DECLARED').map(s=>s.note)})),
  reviewRequiredStores:reviewStores.map(d=>({storeId:d.storeId,storeName:d.storeName,current:d.currentActualVisitDate,submissions:d.submissions.filter(s=>s.classification==='AMBIGUOUS_FINAL_OUTCOME').map(s=>({status:s.status,completedAt:s.completedAt,note:s.note}))})),
  invariants:{
    storeIdsUnique:unique(ids),
    legacyStoreKeysUnique:unique(keys),
    allLivePoeKeysResolve:unresolvedPoeKeys.length===0,
    writesEnabled:false,
    deletes:0
  },
  touchedSourceWorkbook:false,
  touchedV4Stores:false,
  touchedV4Poe:false,
  touchedV4Photos:false,
  touchedDrive:false,
  touchedPhotoWorker:false,
  deletes:0
};

fs.mkdirSync(OUT_DIR,{recursive:true});
fs.writeFileSync(path.join(OUT_DIR,'actual-visit-date-audit.json'),JSON.stringify({summary,details},null,2));
let md=`# SMF Actual Visit Date Audit\n\n**Mode:** READ ONLY  \n**Policy:** ${summary.policy}\n\n## Result\n\n- Identity rows: ${summary.identityRows}\n- LIVE V4_POE rows: ${summary.livePoeRows}\n- Current Actual Visit Dates populated: ${currentPopulated}\n- Conservative proposed Actual Visit Dates populated: ${proposedPopulated}\n- Rows that would change under the conservative rule: ${changed.length}\n- DELETE: 0\n\n## Evidence classes\n\n`;
for(const [k,v] of Object.entries(evidenceCounts))md+=`- ${k}: ${v}\n`;
md+='\n## Rule\n\n';for(const r of summary.rule)md+=`- ${r}\n`;
md+='\n## Explicit no-visit stores\n\n';for(const d of noVisitStores)md+=`- ${d.storeId} — ${d.storeName} — current ${d.currentActualVisitDate||'(blank)'} → proposed (blank)\n`;
md+='\n## Review required\n\n';for(const d of reviewStores)md+=`- ${d.storeId} — ${d.storeName} — current ${d.currentActualVisitDate||'(blank)'}\n`;
md+='\n## Proposed changes\n\n';for(const d of changed)md+=`- ${d.storeId} — ${d.storeName}: ${d.currentActualVisitDate||'(blank)'} → ${d.proposedActualVisitDate||'(blank)'} [${d.evidenceClass}]\n`;
fs.writeFileSync(path.join(OUT_DIR,'actual-visit-date-audit.md'),md);
console.log(JSON.stringify(summary,null,2));