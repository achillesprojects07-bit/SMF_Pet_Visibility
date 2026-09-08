#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';

const SHEET=process.env.GOOGLE_SHEET_ID||'1TNrb3ir8vS6CyZ8kXhRH43JXoH4Ws7iQ4g3649KQTf0';
const API=String(process.env.FIELD_API_BASE_URL||'https://smf-pet-visibility-api.achilles-projects07.workers.dev').replace(/\/$/,'');
const ORIGIN=process.env.FIELD_BROWSER_ORIGIN||'https://achillesprojects07-bit.github.io';
const OUT='migration/live-field-runtime-output';
const WRITES=new Set(['saveStoreV4','submitStoreVisitV4','submitDayV4','removePhotoV4','rescheduleStoreV4','reopenStoreVisitV4','createUserV4','setUserActiveV4','setUserTeamV4','resetUserCodeV4','setStoreGuideV4','setCategoryGuideV4','createOrResetClientAccessV4']);
const t=v=>String(v??'').trim();
const truth=v=>v===true||String(v).toUpperCase()==='TRUE'||String(v)==='1';
const sha=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const obj=values=>{if(!values?.length)return[];const h=values[0].map(t);return values.slice(1).filter(r=>r.some(v=>t(v)!=='')).map((r,i)=>{const o={__row:i+2};h.forEach((k,j)=>{if(k)o[k]=r[j]??''});return o})};
async function token(){const need=n=>{const v=t(process.env[n]);if(!v)throw Error('Missing '+n);return v};const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:need('GOOGLE_OAUTH_CLIENT_ID'),client_secret:need('GOOGLE_OAUTH_CLIENT_SECRET'),refresh_token:need('GOOGLE_OAUTH_REFRESH_TOKEN'),grant_type:'refresh_token'})});const d=await r.json();if(!r.ok||!d.access_token)throw Error('OAuth refresh failed');return d.access_token}
async function range(tok,rng){const u=`https://sheets.googleapis.com/v4/spreadsheets/${SHEET}/values/${encodeURIComponent(rng)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;const r=await fetch(u,{headers:{authorization:`Bearer ${tok}`}});if(!r.ok)throw Error(`GET ${rng} failed ${r.status}`);return(await r.json()).values||[]}
async function api(action,args=[]){if(WRITES.has(action))throw Error('WRITE ACTION FORBIDDEN: '+action);const r=await fetch(API+'/api/action',{method:'POST',headers:{'content-type':'application/json','Origin':ORIGIN},body:JSON.stringify({action,args})});let d={};try{d=await r.json()}catch{throw Error(`${action} unreadable ${r.status}`)}if(!r.ok||d?.ok===false)throw Error(d?.error||`${action} failed ${r.status}`);return Object.prototype.hasOwnProperty.call(d,'result')?d.result:d}

if(process.argv.includes('--self-test')){let blocked=false;try{await api('saveStoreV4',[])}catch(e){blocked=/WRITE ACTION FORBIDDEN/.test(String(e.message))}if(!blocked||WRITES.has('getFieldHomeV4'))throw Error('SELF TEST FAILED');console.log(JSON.stringify({ok:true,origin:ORIGIN,writeBlocked:true},null,2));process.exit(0)}

const tok=await token();
const [uv,sv]=await Promise.all([range(tok,'V4_USERS!A1:H200'),range(tok,'V4_STORES!A1:R1000')]);
const users=obj(uv),stores=obj(sv);
const u=users.find(x=>String(x.Role||'').toUpperCase()==='FIELD'&&truth(x.Active)&&t(x['Access Code']));
if(!u)throw Error('No active FIELD account');
const code=t(u['Access Code']),team=t(u['Assigned Team']);
const login=await api('loginV4',[code]);
if(String(login?.user?.role||'').toUpperCase()!=='FIELD')throw Error('Live login role mismatch');
const home=await api('getFieldHomeV4',[code]);
const returned=Array.isArray(home?.stores)?home.stores:[];
const keyOf=s=>t(s?.key||s?.storeKey||s?.['Store Key']);
const active=stores.filter(s=>truth(s.Active)&&t(s['Assigned Team'])===team);
const inactive=stores.filter(s=>!truth(s.Active)&&t(s['Assigned Team'])===team);
const rk=new Set(returned.map(keyOf)),ak=new Set(active.map(s=>t(s['Store Key'])));
const unexpected=[...rk].filter(k=>k&&!ak.has(k));
const missing=[...ak].filter(k=>k&&!rk.has(k));
const inactiveReturned=inactive.filter(s=>rk.has(t(s['Store Key']))).map(s=>({storeId:t(s['Store ID']),storeKey:t(s['Store Key'])}));
let knownOpen=true;if(returned.length){const detail=await api('getStoreV4',[code,keyOf(returned[0])]);knownOpen=!!detail}
let unknownRejected=false;try{await api('getStoreV4',[code,'__SMF_LIVE_VERIFY_NONEXISTENT_STORE_KEY__'])}catch{unknownRejected=true}
const direct=inactive.length>0&&inactiveReturned.length===0;
const invariants={readOnly:true,noWriteActionsInvoked:true,liveApiReached:true,fieldLoginConfirmed:true,noUnexpectedStoresReturned:unexpected.length===0,allActiveTeamStoresReturned:missing.length===0,knownStoreCanOpen:knownOpen,unknownStoreRejected:unknownRejected,inactiveStoreNotReturned:inactiveReturned.length===0};
const certification={activeFalseSemanticsDirectlyProven:direct,reason:direct?'Live inactive store(s) exist and were absent from deployed Field home.':'No live Active=FALSE store exists for a zero-write direct containment test.',productionApplyUnlockAllowed:false,executorMustRemainHardLocked:true};
const report={generatedAt:new Date().toISOString(),mode:'LIVE_RUNTIME_READ_ONLY_VERIFY_V2',apiBaseUrl:API,browserOrigin:ORIGIN,fieldAccount:{displayName:t(u['Display Name']),team},counts:{liveStores:stores.length,activeTeamStores:active.length,inactiveTeamStores:inactive.length,returnedStores:returned.length},unexpectedReturned:unexpected,missingActive:missing,inactiveReturned,invariants,certification,fingerprint:sha({stores:stores.map(s=>[s['Store ID'],s['Store Key'],s['Assigned Team'],s.Active]),returned:[...rk].sort()})};
fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(`${OUT}/live-field-runtime-verification.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({mode:report.mode,counts:report.counts,invariants,certification,fingerprint:report.fingerprint},null,2));
if(Object.values(invariants).some(v=>v!==true))process.exitCode=2;
