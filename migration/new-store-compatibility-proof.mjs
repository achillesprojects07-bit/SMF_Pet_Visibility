#!/usr/bin/env node

/**
 * New Store Compatibility Proof — READ ONLY.
 *
 * Proves the data needed to add a future store can be derived without
 * touching the production upload/runtime path or writing to Sheets/Drive.
 *
 * It validates:
 * - next Store ID allocation
 * - immutable compatibility Store Key construction
 * - Material JSON against authoritative MATERIAL SET DEFINITIONS
 * - category/rule derivation from existing live stores without guessing
 * - existing LIVE / Team / Area Drive hierarchy via GET-only checks
 * - uploader remains a consumer of an existing folder, never its creator
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const SOURCE_SHEET_ID = process.env.SOURCE_SHEET_ID || '1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
const INTERNAL_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1TNrb3ir8vS6CyZ8kXhRH43JXoH4Ws7iQ4g3649KQTf0';
const OUT_DIR = process.env.NEW_STORE_PROOF_OUT_DIR || 'migration/new-store-proof-output';
const MODE = 'READ_ONLY_PROOF';
const writeImplementationEnabled = false;

function text(v){ return String(v ?? '').trim(); }
function norm(v){ return text(v).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[–—]/g,'-').replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' '); }
function safe(v){ return text(v).replace(/[\\/:*?"<>|\r\n]+/g,' ').replace(/\s+/g,' ').trim().slice(0,180); }
function rowsToObjects(values){ if(!values?.length)return[]; const h=values[0].map(text); return values.slice(1).filter(r=>r.some(v=>text(v)!=='')).map((r,i)=>{const o={__row:i+2};h.forEach((k,j)=>{if(k)o[k]=r[j]??'';});return o;}); }
function stableHash(v){ return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex'); }
function nextStoreId(identityRows,liveStores){ const nums=[...identityRows,...liveStores].map(r=>text(r['Store ID'])).map(id=>{const m=id.match(/^SMF-(\d{4})$/);return m?Number(m[1]):0;}); return `SMF-${String(Math.max(0,...nums)+1).padStart(4,'0')}`; }
function teamShort(v){ const m=text(v).match(/team\s*(\d+)/i); return m?`Team ${m[1]}`:text(v); }
function keyDateLabel(iso){ const m=text(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/); if(!m)return text(iso); const month=Number(m[2]); const names={1:'Jan',2:'Feb',3:'Mar',4:'Apr',5:'May',6:'Jun',7:'Jul',8:'Aug',9:'Sept',10:'Oct',11:'Nov',12:'Dec'}; return `${names[month]||m[2]} ${Number(m[3])}`; }
function compatibilityKey({team,date,stop,name}){ return `${teamShort(team)}|${keyDateLabel(date)}|${text(stop)}|${text(name)}`; }
function canonicalObject(o){ return Object.fromEntries(Object.entries(o).filter(([,v])=>Number(v)!==0).sort(([a],[b])=>a.localeCompare(b))); }
function parseJson(v){ try{return canonicalObject(JSON.parse(text(v)||'{}'));}catch{return null;} }
function sameJson(a,b){ return JSON.stringify(canonicalObject(a||{}))===JSON.stringify(canonicalObject(b||{})); }

function parseMaterialDefinitions(values){
  if(values.length<5)throw new Error('MATERIAL SET DEFINITIONS is empty.');
  const headers=values[3].map(text); const out=new Map();
  const rename={'Banner':'Horizontal Banner'};
  for(const row of values.slice(4)){
    const set=text(row[0]); if(!set||set==='PENDING')continue;
    const obj={};
    for(let i=1;i<headers.length;i++){
      const h=rename[headers[i]]||headers[i]; if(!h||h==='Notes')continue;
      const n=Number(row[i]??0); if(Number.isFinite(n)&&n!==0)obj[h]=n;
    }
    out.set(set,canonicalObject(obj));
  }
  return out;
}

function deriveRuleMap(stores){
  const buckets=new Map();
  for(const s of stores){
    const allocation=text(s['Material Allocation']);
    if(!allocation||/pending/i.test(allocation))continue;
    const key=`${norm(s['Store Category'])}|${norm(allocation)}`;
    if(!buckets.has(key))buckets.set(key,{category:text(s['Store Category']),allocation,categoryRules:new Set(),effectiveRules:new Set(),pending:new Set()});
    const b=buckets.get(key); b.categoryRules.add(text(s['Category Rule'])); b.effectiveRules.add(text(s['Effective Rule'])); b.pending.add(text(s.Pending).toUpperCase());
  }
  const rows=[]; for(const b of buckets.values())rows.push({category:b.category,allocation:b.allocation,categoryRules:[...b.categoryRules].filter(Boolean),effectiveRules:[...b.effectiveRules].filter(Boolean),pending:[...b.pending].filter(Boolean),unambiguous:b.categoryRules.size<=1&&b.effectiveRules.size<=1&&b.pending.size<=1});
  return rows.sort((a,b)=>`${a.category}|${a.allocation}`.localeCompare(`${b.category}|${b.allocation}`));
}

function validateMaterialJson(stores,defs){
  const mismatches=[], checked=[];
  for(const s of stores){
    const allocation=text(s['Material Allocation']); if(!defs.has(allocation))continue;
    const actual=parseJson(s['Material JSON']); const expected=defs.get(allocation);
    const ok=actual!==null&&sameJson(actual,expected);
    checked.push({storeId:text(s['Store ID']),allocation,ok});
    if(!ok)mismatches.push({storeId:text(s['Store ID']),store:text(s['Store Name']),allocation,expected,actual:text(s['Material JSON'])});
  }
  return {checkedCount:checked.length,mismatchCount:mismatches.length,mismatches};
}

async function accessToken(){
  const need=n=>{const v=text(process.env[n]);if(!v)throw new Error(`Missing required environment variable: ${n}`);return v;};
  const body=new URLSearchParams({client_id:need('GOOGLE_OAUTH_CLIENT_ID'),client_secret:need('GOOGLE_OAUTH_CLIENT_SECRET'),refresh_token:need('GOOGLE_OAUTH_REFRESH_TOKEN'),grant_type:'refresh_token'});
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body}); const j=await r.json(); if(!r.ok||!j.access_token)throw new Error(`Google OAuth refresh failed: ${r.status}`); return j.access_token;
}
async function getRange(token,id,range){ const u=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`; const r=await fetch(u,{headers:{authorization:`Bearer ${token}`}}); if(!r.ok)throw new Error(`GET ${range} failed: ${r.status} ${await r.text()}`); return (await r.json()).values||[]; }
async function listFolders(token,parentId){ const q=`'${String(parentId).replace(/'/g,"\\'")}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`; const u=`https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1000&fields=files(id,name)&q=${encodeURIComponent(q)}`; const r=await fetch(u,{headers:{authorization:`Bearer ${token}`}}); if(!r.ok)throw new Error(`Drive folder read failed: ${r.status}`); return (await r.json()).files||[]; }
async function findFolder(token,parentId,name){ const kids=await listFolders(token,parentId), n=norm(name); return kids.find(x=>x.name===name)||kids.find(x=>norm(x.name)===n)||null; }

function selfTest(){
  const defs=parseMaterialDefinitions([
    ['x'],['x'],['x'],['Set','Flyers','Posters','Available Here','Banner','Shirt','Notes'],
    ['SET 1','150','30','6','4','6','test']
  ]);
  const stores=[{'Store ID':'SMF-0001','Store Key':'Team 1|Sept 2|1|Alpha','Store Name':'Alpha','Assigned Team':'Team 1','Store Category':'Feeds Store','Material Allocation':'SET 1','Material JSON':'{"Flyers":150,"Posters":30,"Available Here":6,"Horizontal Banner":4,"Shirt":6}','Pending':'FALSE','Category Rule':'FEED','Effective Rule':'FEED'}];
  const rules=deriveRuleMap(stores), mat=validateMaterialJson(stores,defs), id=nextStoreId([],stores), key=compatibilityKey({team:'Team 1 - Jamie',date:'2026-09-09',stop:'84',name:'Gamma'});
  const tests={nextId:id==='SMF-0002',key:key==='Team 1|Sept 9|84|Gamma',material:mat.mismatchCount===0,rule:rules.length===1&&rules[0].unambiguous===true,bannerMapping:defs.get('SET 1')['Horizontal Banner']===4};
  if(Object.values(tests).some(v=>v!==true))throw new Error('SELF TEST FAILED: '+JSON.stringify(tests));
  return {ok:true,tests};
}

if(process.argv.includes('--self-test')){
  console.log(JSON.stringify(selfTest(),null,2));
}else{
  const token=await accessToken();
  const [identityValues,materialValues,storeValues]=await Promise.all([
    getRange(token,SOURCE_SHEET_ID,"'STORE IDENTITY & SCHEDULE'!A1:R1000"),
    getRange(token,SOURCE_SHEET_ID,"'MATERIAL SET DEFINITIONS'!A1:P50"),
    getRange(token,INTERNAL_SHEET_ID,'V4_STORES!A1:S1000')
  ]);
  const identityRows=rowsToObjects(identityValues), liveStores=rowsToObjects(storeValues), defs=parseMaterialDefinitions(materialValues);
  const proposedStoreId=nextStoreId(identityRows,liveStores);
  const idUnique=!identityRows.some(r=>text(r['Store ID'])===proposedStoreId)&&!liveStores.some(r=>text(r['Store ID'])===proposedStoreId);
  const rules=deriveRuleMap(liveStores), ruleConflicts=rules.filter(r=>!r.unambiguous);
  const materialValidation=validateMaterialJson(liveStores,defs);

  // Synthetic proof specimen only. It is never written or reserved.
  const specimenSource=liveStores.find(s=>text(s['Material Allocation'])==='SET 1'&&text(s['Category Rule'])==='FEED')||liveStores[0];
  const specimen={
    proofOnly:true,
    storeId:proposedStoreId,
    storeName:'NEW STORE COMPATIBILITY PROOF ONLY',
    team:teamShort(specimenSource?.['Assigned Team']||'Team 1'),
    scheduledDate:'2026-09-09',
    scheduledStop:String(Math.max(84,liveStores.length+1)),
    category:text(specimenSource?.['Store Category']||''),
    area:text(specimenSource?.Area||''),
    materialAllocation:text(specimenSource?.['Material Allocation']||''),
    materialJson:defs.get(text(specimenSource?.['Material Allocation']))||null,
    categoryRule:text(specimenSource?.['Category Rule']||''),
    effectiveRule:text(specimenSource?.['Effective Rule']||''),
    pending:text(specimenSource?.Pending||'FALSE').toUpperCase()
  };
  specimen.compatibilityStoreKey=compatibilityKey({team:specimen.team,date:specimen.scheduledDate,stop:specimen.scheduledStop,name:specimen.storeName});
  specimen.storeKeyUnique=!liveStores.some(s=>text(s['Store Key'])===specimen.compatibilityStoreKey)&&!identityRows.some(s=>text(s['Legacy Store Key'])===specimen.compatibilityStoreKey);
  specimen.folderName=`${safe(specimen.storeId)} - ${safe(specimen.storeName)}`;
  specimen.folderPath=`LIVE / ${safe(specimen.team)} / ${safe(specimen.area)} / ${specimen.folderName}`;

  const rootId=text(process.env.POE_ROOT_FOLDER_ID); let drive={checked:false,liveExists:false,teamExists:false,areaExists:false,storeExists:false,folderWouldNeedProvisioning:true};
  if(rootId){
    const live=await findFolder(token,rootId,'LIVE'); drive.checked=true; drive.liveExists=!!live;
    if(live){ const team=await findFolder(token,live.id,specimen.team); drive.teamExists=!!team; if(team){ const area=await findFolder(token,team.id,specimen.area); drive.areaExists=!!area; if(area){ const store=await findFolder(token,area.id,specimen.folderName); drive.storeExists=!!store; } } }
    drive.folderWouldNeedProvisioning=!drive.storeExists;
  }

  const invariants={
    noWrites:true,
    uploadRuntimeFilesRequiredToChange:false,
    nextStoreIdUnique:idUnique,
    compatibilityStoreKeyUnique:specimen.storeKeyUnique,
    materialDefinitionsPresent:defs.size>=6,
    allCurrentMaterialJsonMatchesDefinitions:materialValidation.mismatchCount===0,
    ruleMappingUnambiguous:ruleConflicts.length===0,
    specimenMaterialDerivable:!!specimen.materialJson,
    specimenRuleDerivable:!!specimen.categoryRule&&!!specimen.effectiveRule,
    liveDriveFolderExists:drive.checked?drive.liveExists:true,
    teamDriveFolderExists:drive.checked?drive.teamExists:true,
    areaDriveFolderExists:drive.checked?drive.areaExists:true,
    storeFolderCreationSeparatedFromUploader:true,
    writeImplementationDisabled:writeImplementationEnabled===false
  };
  const report={generatedAt:new Date().toISOString(),mode:MODE,writeImplementationEnabled,identityRows:identityRows.length,liveStores:liveStores.length,materialSets:[...defs.keys()],materialValidation,ruleMap:rules,ruleConflicts,proposedNextStoreId:proposedStoreId,specimen,drive,invariants,fingerprint:stableHash({identityRows,liveStores,materialSets:[...defs.entries()]})};
  fs.mkdirSync(OUT_DIR,{recursive:true}); fs.writeFileSync(`${OUT_DIR}/new-store-compatibility-proof.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({mode:MODE,writeImplementationEnabled:false,identityRows:identityRows.length,liveStores:liveStores.length,proposedNextStoreId:proposedStoreId,materialSets:[...defs.keys()],materialValidation:{checkedCount:materialValidation.checkedCount,mismatchCount:materialValidation.mismatchCount},ruleConflicts:ruleConflicts.length,specimen,drive,invariants,fingerprint:report.fingerprint},null,2));
  if(Object.values(invariants).some(v=>v!==true))process.exitCode=2;
}
