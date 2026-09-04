const required = ['GOOGLE_OAUTH_CLIENT_ID','GOOGLE_OAUTH_CLIENT_SECRET','GOOGLE_OAUTH_REFRESH_TOKEN','GOOGLE_SHEET_ID','POE_ROOT_FOLDER_ID'];
for (const k of required) if (!process.env[k]) throw new Error(`Missing ${k}`);

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID.trim();
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET.trim();
const REFRESH_TOKEN = process.env.GOOGLE_OAUTH_REFRESH_TOKEN.trim();
const SHEET_ID = process.env.GOOGLE_SHEET_ID.trim();
const ROOT_ID = process.env.POE_ROOT_FOLDER_ID.trim();

function norm(v='') {
  return String(v).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[–—]/g,'-').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
}
function q(v='') { return String(v).replace(/'/g,"\\'"); }
function safe(v='') { return String(v).replace(/[\\/:*?"<>|\r\n]+/g,' ').replace(/\s+/g,' ').trim().slice(0,180); }

async function token() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:CLIENT_ID,client_secret:CLIENT_SECRET,refresh_token:REFRESH_TOKEN,grant_type:'refresh_token'})
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error(`OAuth refresh failed: ${d.error || r.status}`);
  return d.access_token;
}
const accessToken = await token();
async function gf(url, init={}) {
  const r = await fetch(url, {...init, headers:{...(init.headers||{}), Authorization:`Bearer ${accessToken}`}});
  const text = await r.text(); let d={}; try { d = text ? JSON.parse(text) : {}; } catch { d={raw:text}; }
  if (!r.ok) throw new Error(`Google API ${r.status}: ${JSON.stringify(d)}`);
  return d;
}
async function children(parentId) {
  const query = `'${q(parentId)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  let out=[], pageToken='';
  do {
    const u = new URL('https://www.googleapis.com/drive/v3/files');
    u.searchParams.set('spaces','drive'); u.searchParams.set('pageSize','1000'); u.searchParams.set('fields','nextPageToken,files(id,name)'); u.searchParams.set('q',query);
    if (pageToken) u.searchParams.set('pageToken',pageToken);
    const d = await gf(u.toString()); out.push(...(d.files||[])); pageToken=d.nextPageToken||'';
  } while(pageToken);
  return out;
}
async function createFolder(parentId,name) {
  return gf('https://www.googleapis.com/drive/v3/files?fields=id,name,parents', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name, mimeType:'application/vnd.google-apps.folder', parents:[parentId]})
  });
}
async function getOrCreate(parentId,name,{allowCreate=true}={}) {
  const kids = await children(parentId); const n = norm(name);
  const exact = kids.find(x => x.name === name) || kids.find(x => norm(x.name) === n);
  if (exact) return {folder:exact,created:false};
  if (!allowCreate) return {folder:null,created:false};
  return {folder:await createFolder(parentId,name),created:true};
}

const range = encodeURIComponent('V4_STORES!A1:S200');
const sheet = await gf(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SHEET_ID)}/values/${range}?majorDimension=ROWS`);
const rows = sheet.values || [];
if (rows.length < 2) throw new Error('V4_STORES is empty.');
const headers = rows[0].map(String); const idx={}; headers.forEach((h,i)=>idx[h]=i);
for (const h of ['Store Name','Assigned Team','Area','Active','Store ID']) if (idx[h] === undefined) throw new Error(`Missing V4_STORES column: ${h}`);
const stores = rows.slice(1).filter(r => ['true','1','yes'].includes(String(r[idx['Active']]||'').trim().toLowerCase())).map(r => ({
  name:String(r[idx['Store Name']]||'').trim(), team:String(r[idx['Assigned Team']]||'').trim(), area:String(r[idx['Area']]||'').trim(), storeId:String(r[idx['Store ID']]||'').trim()
})).filter(s=>s.name&&s.team&&s.area);

const summary={activeStores:stores.length,createdTeams:0,createdAreas:0,createdStores:0,reusedStores:0,errors:[]};
const live = await getOrCreate(ROOT_ID,'LIVE',{allowCreate:false});
if (!live.folder) throw new Error('LIVE folder is missing under POE root; provisioning stopped without creating anything above team level.');
const teamCache=new Map(), areaCache=new Map();

for (const s of stores) {
  try {
    let team = teamCache.get(norm(s.team));
    if (!team) {
      const t = await getOrCreate(live.folder.id,s.team); team=t.folder; teamCache.set(norm(s.team),team); if(t.created) summary.createdTeams++;
    }
    const ak=`${team.id}|${norm(s.area)}`;
    let area = areaCache.get(ak);
    if (!area) {
      const a=await getOrCreate(team.id,s.area); area=a.folder; areaCache.set(ak,area); if(a.created) summary.createdAreas++;
    }
    const kids=await children(area.id); const nn=norm(s.name), ni=norm(s.storeId);
    let match = kids.find(k => s.storeId && norm(k.name).startsWith(ni+' ')) || kids.find(k => norm(k.name)===nn) || kids.find(k => nn && norm(k.name).endsWith(nn));
    if (match) { summary.reusedStores++; continue; }
    const folderName = s.storeId ? `${safe(s.storeId)} - ${safe(s.name)}` : safe(s.name);
    await createFolder(area.id,folderName); summary.createdStores++;
  } catch (e) {
    summary.errors.push({storeId:s.storeId,store:s.name,team:s.team,area:s.area,error:String(e?.message||e)});
  }
}

console.log(JSON.stringify(summary,null,2));
if (summary.errors.length) process.exitCode=1;
