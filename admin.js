(() => {
  'use strict';
  const API=String(window.SMF_CONFIG?.API_BASE_URL||'').replace(/\/$/,'');
  const $=id=>document.getElementById(id);
  const state={code:sessionStorage.getItem('smf_admin_code')||'',user:null,dashboard:null,issues:null,users:null,system:null,health:null,photoHealth:null,tab:'overview',loading:new Set()};

  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]))}
  function label(s){s=String(s||'NOT STARTED').toUpperCase();return s==='CLOSED'?'STORE CLOSED':s==='NOT STARTED'?'OPEN':s}
  function cls(s){s=String(s||'OPEN').toUpperCase();return s==='COMPLETED'?'completed':s==='INCOMPLETE'?'incomplete':s==='REFUSED'?'refused':s==='CLOSED'?'closed':'open'}
  function toast(msg,type='info'){const t=$('adminToast');t.textContent=msg;t.dataset.type=type;t.classList.remove('hidden');clearTimeout(window.__adminToast);window.__adminToast=setTimeout(()=>t.classList.add('hidden'),3500)}
  function requireApi(){if(!API)throw new Error('Admin API is not configured.')}
  async function api(action,args=[]){requireApi();let r;try{r=await fetch(API+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,args}),cache:'no-store',credentials:'omit'})}catch(_){throw new Error('Network connection failed. Check signal and retry.')}let d={};try{d=await r.json()}catch(_){throw new Error('Server returned an unreadable response.')}if(!r.ok||d.ok===false)throw new Error(d.error||('Server error '+r.status));return Object.prototype.hasOwnProperty.call(d,'result')?d.result:d}
  function loading(tab,text='Loading…'){$('tab_'+tab).innerHTML=`<section class="card loading">${esc(text)}</section>`}
  function panelError(tab,err){$('tab_'+tab).innerHTML=`<section class="card"><h2>Could not load this section</h2><p class="error">${esc(err.message||err)}</p><button class="secondary retryTab">Retry</button></section>`;const b=$('tab_'+tab).querySelector('.retryTab');if(b)b.onclick=()=>loadTab(tab,true)}

  async function login(code){
    const r=await api('loginV4',[code]);
    if(!r?.user||r.user.role!=='ADMIN')throw new Error('This page requires an Admin access code.');
    state.code=code;state.user=r.user;sessionStorage.setItem('smf_admin_code',code);
    $('adminLogout').classList.remove('hidden');$('adminLogin').classList.add('hidden');$('adminApp').classList.remove('hidden');
    $('adminHello').textContent='Hello, '+(r.user.name||'Admin');$('adminMeta').textContent='ADMIN • '+r.mode+' • Backend '+r.version;
    selectTab('overview',true);
  }

  $('adminLoginForm').onsubmit=async e=>{e.preventDefault();$('adminLoginError').textContent='';$('adminLoginBtn').disabled=true;$('adminLoginBtn').textContent='Signing in…';try{await login($('adminCode').value.trim())}catch(err){$('adminLoginError').textContent=err.message}finally{$('adminLoginBtn').disabled=false;$('adminLoginBtn').textContent='Sign in'}};
  $('adminLogout').onclick=()=>{sessionStorage.removeItem('smf_admin_code');state.code='';state.user=null;$('adminLogout').classList.add('hidden');$('adminApp').classList.add('hidden');$('adminLogin').classList.remove('hidden')};
  $('adminRefresh').onclick=()=>loadTab(state.tab,true);

  document.querySelectorAll('.adminTab').forEach(b=>b.onclick=()=>selectTab(b.dataset.tab));
  function selectTab(tab,force=false){state.tab=tab;document.querySelectorAll('.adminTab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));document.querySelectorAll('.adminPanel').forEach(p=>p.classList.add('hidden'));$('tab_'+tab).classList.remove('hidden');loadTab(tab,force)}
  async function loadTab(tab,force=false){
    if(state.loading.has(tab))return;
    state.loading.add(tab);$('adminRefresh').disabled=true;
    try{
      if(tab==='overview')await loadOverview(force);
      else if(tab==='stores')await loadStores(force);
      else if(tab==='issues')await loadIssues(force);
      else if(tab==='users')await loadUsers(force);
      else if(tab==='system')await loadSystem(force);
    }catch(err){panelError(tab,err)}finally{state.loading.delete(tab);$('adminRefresh').disabled=false}
  }

  async function loadOverview(force){
    if(force||!state.dashboard){loading('overview','Loading deployment overview…');state.dashboard=await api('getAdminDashboardV4',[state.code])}
    renderOverview();
  }
  function renderOverview(){
    const d=state.dashboard||{};
    $('tab_overview').innerHTML=`
      <section class="card"><h2>Deployment Overview</h2><p class="small">At-a-glance status of all active stores across both field teams. Use this to see overall progress and where attention is needed.</p></section>
      <div class="metricGrid">
        <div class="metric total"><b>${Number(d.total||0)}</b><span>Total Stores</span></div>
        <div class="metric completed"><b>${Number(d.completed||0)}</b><span>Completed</span></div>
        <div class="metric incomplete"><b>${Number(d.incomplete||0)}</b><span>Incomplete</span></div>
        <div class="metric refused"><b>${Number(d.refused||0)}</b><span>Refused</span></div>
        <div class="metric closed"><b>${Number(d.closed||0)}</b><span>Store Closed</span></div>
        <div class="metric open"><b>${Number(d.notStarted||0)}</b><span>Open</span></div>
      </div>
      <div class="adminGrid2">
        <section class="card"><div class="sectionTitle"><h2>Deployment Progress</h2><b>${Number(d.progressPct||0)}%</b></div><div class="progressTrack" style="height:12px"><div class="progressBar" style="width:${Number(d.progressPct||0)}%"></div></div><p class="small">${Number(d.finalized||0)} of ${Number(d.total||0)} stores finalized.</p></section>
        <section class="card"><h2>Attention</h2><div class="systemLine"><span>Guide review</span><b>${Number(d.review||0)}</b></div><div class="systemLine"><span>Open stores</span><b>${Number(d.notStarted||0)}</b></div><div class="systemLine"><span>Last store sync</span><b>${esc(d.lastSync||'—')}</b></div></section>
      </div>
      <section class="card adminTableCard"><div class="sectionTitle"><h2>By Day</h2><span class="small">Both teams combined</span></div>${dayTable(d.days||[])}</section>
      <section class="card adminTableCard"><div class="sectionTitle"><h2>By Area</h2></div>${areaTable(d.areas||[])}</section>`;
  }
  function dayTable(days){return `<table class="adminTable"><thead><tr><th>Day</th><th>Total</th><th>Completed</th><th>Incomplete</th><th>Refused</th><th>Closed</th><th>Open</th><th>Day Submitted</th></tr></thead><tbody>${days.map(x=>`<tr><td><b>${esc(x.day)}</b></td><td>${x.total}</td><td>${x.completed}</td><td>${x.incomplete}</td><td>${x.refused}</td><td>${x.closed}</td><td>${x.notStarted}</td><td>${x.daySubmitted?'✓ Yes':'No'}</td></tr>`).join('')}</tbody></table>`}
  function areaTable(rows){return `<table class="adminTable"><thead><tr><th>Area</th><th>Total</th><th>Completed</th><th>Incomplete</th><th>Refused</th><th>Closed</th><th>Open</th></tr></thead><tbody>${rows.map(x=>`<tr><td><b>${esc(x.area)}</b></td><td>${x.total}</td><td>${x.completed}</td><td>${x.incomplete}</td><td>${x.refused}</td><td>${x.closed}</td><td>${x.notStarted}</td></tr>`).join('')}</tbody></table>`}

  async function loadStores(force){if(force||!state.dashboard){loading('stores','Loading stores…');state.dashboard=await api('getAdminDashboardV4',[state.code])}renderStores()}
  function renderStores(){
    const rows=state.dashboard?.stores||[];
    const teams=[...new Set(rows.map(x=>x.team).filter(Boolean))].sort(),days=[...new Set(rows.map(x=>x.day).filter(Boolean))].sort();
    $('tab_stores').innerHTML=`<section class="card"><div class="sectionTitle"><h2>Stores & POE</h2><span class="small">Search a store, check status, then open it to inspect inventory, notes and POE.</span></div><div class="filterBar"><input id="storeSearch" placeholder="Search store or area"><select id="storeTeam"><option value="">All teams</option>${teams.map(x=>`<option>${esc(x)}</option>`).join('')}</select><select id="storeDay"><option value="">All days</option>${days.map(x=>`<option>${esc(x)}</option>`).join('')}</select><select id="storeStatus"><option value="">All statuses</option><option>COMPLETED</option><option>INCOMPLETE</option><option>REFUSED</option><option value="CLOSED">STORE CLOSED</option><option value="NOT STARTED">OPEN</option></select></div><div id="adminStoreDetail"></div><div id="storeTableWrap"></div></section>`;
    const paint=()=>{const q=$('storeSearch').value.toLowerCase(),team=$('storeTeam').value,day=$('storeDay').value,status=$('storeStatus').value;const filtered=rows.filter(x=>(!q||(x.name+' '+x.area).toLowerCase().includes(q))&&(!team||x.team===team)&&(!day||x.day===day)&&(!status||x.status===status));$('storeTableWrap').innerHTML=`<div class="adminTableCard"><table class="adminTable"><thead><tr><th>Store</th><th>Team</th><th>Day</th><th>Area</th><th>Status</th><th>Completed</th><th>Open</th></tr></thead><tbody>${filtered.map(x=>`<tr class="adminStoreRow" data-key="${esc(x.key)}"><td><b>${esc(x.name)}</b><div class="small">Stop ${esc(x.stop)} • ${esc(x.category)}</div></td><td>${esc(x.team)}</td><td>${esc(x.day)}</td><td>${esc(x.area)}</td><td><span class="statusDot ${cls(x.status)}"></span><b>${esc(label(x.status))}</b></td><td>${esc(x.completedAt||'—')}</td><td><button type="button" class="secondary adminOpenStore" data-key="${esc(x.key)}">OPEN</button></td></tr>`).join('')}</tbody></table></div>`};
    const wrap=$('storeTableWrap');
    wrap.onclick=e=>{const b=e.target.closest('.adminOpenStore');if(b){e.preventDefault();e.stopPropagation();openAdminStore(b.dataset.key);return}const r=e.target.closest('.adminStoreRow');if(r)openAdminStore(r.dataset.key)};
    ['storeSearch','storeTeam','storeDay','storeStatus'].forEach(id=>$(id).oninput=paint);paint();
  }
  async function openAdminStore(key){
    const detail=$('adminStoreDetail');
    detail.innerHTML='<section class="card loading">Loading store…</section>';
    detail.scrollIntoView({behavior:'smooth',block:'start'});
    try{const r=await api('getAdminStoreV4',[state.code,key]),s=r.store,p=r.poe||{},groups=r.photoGroups||{};const pics=Object.keys(groups).flatMap(k=>(groups[k]||[]).map(x=>({base:k,...x})));detail.innerHTML=`<section class="card"><div class="sectionTitle"><div><h2>${esc(s.name)}</h2><div class="small">${esc(s.storeId||'')} • ${esc(s.team)} • ${esc(s.area)} • ${esc(s.category)}</div></div><span class="badge ${cls(p.outcome)}">${esc(label(p.outcome))}</span></div><div class="storeDetail"><div><h3>Visit</h3><div class="systemLine"><span>Finalized by</span><b>${esc(p.completedBy||'—')}</b></div><div class="systemLine"><span>Finalized at</span><b>${esc(p.completedAt||'—')}</b></div><div class="systemLine"><span>Updated</span><b>${esc(p.updatedAt||'—')}</b></div><h3>Notes</h3><p>${esc(p.notes||'—')}</p></div><div><h3>Inventory</h3>${inventoryReadout(s.materials||{},p)}</div></div>${pics.length?`<h3>POE Photos (${pics.length})</h3><div class="photoThumbs">${pics.map(x=>`<a class="photoThumb" href="${esc(x.url||'#')}" target="_blank" rel="noopener"><img src="${esc(x.previewUrl||x.url||'')}" alt="${esc(x.base)}"><b>${esc(x.base)}</b><div class="small">${esc(x.uploadedAt||'')}</div></a>`).join('')}</div>`:'<div class="emptyState">No active POE photos.</div>'}${p.finalized?`<div class="adminActions" style="margin-top:14px"><button id="reopenStore" class="warn">Reopen for Correction</button></div>`:''}</section>`;if($('reopenStore'))$('reopenStore').onclick=()=>reopenStore(key,s.name)}catch(err){detail.innerHTML=`<section class="card error">${esc(err.message)}</section>`}
  }
  function inventoryReadout(mats,p){const keys=Object.keys(mats).filter(k=>Number(mats[k]||0)>0);return keys.length?`<table class="adminTable"><thead><tr><th>Item</th><th>Beg</th><th>Installed</th><th>Remaining</th></tr></thead><tbody>${keys.map(k=>`<tr><td>${esc(k)}</td><td>${Number(p.beginning?.[k]??mats[k]??0)}</td><td>${Number(p.installed?.[k]??0)}</td><td>${Number(p.takeHome?.[k]??((p.beginning?.[k]??mats[k]??0)-(p.installed?.[k]??0)))}</td></tr>`).join('')}</tbody></table>`:'<div class="small">No material allocation.</div>'}
  async function reopenStore(key,name){const reason=prompt('Reason for reopening '+name+' for correction:');if(!reason)return;try{await api('reopenStoreVisitV4',[state.code,key,reason]);toast('Store reopened. Day submission cleared if required.','success');state.dashboard=null;await loadStores(true);await openAdminStore(key)}catch(err){toast(err.message,'error')}}

  async function loadIssues(force){if(force||!state.issues){loading('issues','Checking current issues…');state.issues=await api('getAdminIssuesV4',[state.code])}renderIssues()}
  function renderIssues(){const rows=state.issues?.issues||[];$('tab_issues').innerHTML=`<section class="card"><div class="sectionTitle"><h2>Issues</h2><b>${rows.length}</b></div><p class="small">Stores needing attention because of missing POE, inventory validation or guide review. Nothing is changed automatically.</p></section>${rows.length?rows.map(x=>`<section class="card issueCard ${String(x.priority||'').toLowerCase()}"><div class="sectionTitle"><h2>${esc(x.name)}</h2><span class="tag">${esc(x.priority)} • ${esc(x.type)}</span></div><p>${esc(x.detail)}</p><div class="issueMeta"><span class="tag">${esc(x.team)}</span><span class="tag">${esc(x.area)}</span></div><div class="adminActions" style="margin-top:10px"><button class="secondary issueOpen" data-key="${esc(x.key)}">Inspect Store</button></div></section>`).join(''):'<section class="card emptyState">No current issues.</section>'}`;document.querySelectorAll('.issueOpen').forEach(b=>b.onclick=async()=>{selectTab('stores');await openAdminStore(b.dataset.key)})}

  async function loadUsers(force){if(force||!state.users){loading('users','Loading users…');state.users=await api('getUsersV4',[state.code])}renderUsers()}
  function renderUsers(){const rows=state.users||[];$('tab_users').innerHTML=`<section class="card"><div class="sectionTitle"><h2>Users</h2><button id="newFieldUser">+ Field User</button></div><p class="small">Manage access for Admin, Field and Client users. In LIVE, disable users instead of deleting them.</p><div class="adminTableCard"><table class="adminTable"><thead><tr><th>Name</th><th>Role</th><th>Team</th><th>Access Code</th><th>Active</th><th>Last Used</th><th>Actions</th></tr></thead><tbody>${rows.map(u=>`<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.role)}</td><td>${esc(u.team||'—')}</td><td class="userCode">${esc(u.code)}</td><td>${u.active?'✓ Active':'Disabled'}</td><td>${esc(u.last||'—')}</td><td>${u.role==='ADMIN'?'—':`<div class="adminActions"><button class="secondary userToggle" data-row="${u.row}" data-active="${u.active?'1':'0'}">${u.active?'Disable':'Enable'}</button>${u.role==='FIELD'?`<button class="secondary userTeam" data-row="${u.row}" data-team="${esc(u.team)}">Move Team</button><button class="secondary userReset" data-row="${u.row}">Reset Code</button>`:''}</div>`}</td></tr>`).join('')}</tbody></table></div></section>`;$('newFieldUser').onclick=createFieldUser;document.querySelectorAll('.userToggle').forEach(b=>b.onclick=()=>toggleUser(b));document.querySelectorAll('.userTeam').forEach(b=>b.onclick=()=>moveTeam(b));document.querySelectorAll('.userReset').forEach(b=>b.onclick=()=>resetCode(b))}
  async function reloadUsers(){state.users=null;await loadUsers(true)}
  async function createFieldUser(){const name=prompt('Field user name:');if(!name)return;const team=prompt('Assigned team: enter Team 1 or Team 2','Team 1');if(!team)return;try{const r=await api('createUserV4',[state.code,name,team]);alert('New access code: '+r.code+'\n\nGive this code only to the intended field user.');await reloadUsers()}catch(err){toast(err.message,'error')}}
  async function toggleUser(b){try{await api('setUserActiveV4',[state.code,Number(b.dataset.row),b.dataset.active!=='1']);await reloadUsers()}catch(err){toast(err.message,'error')}}
  async function moveTeam(b){const team=b.dataset.team==='Team 1'?'Team 2':'Team 1';if(!confirm('Move this field user to '+team+'? Their access code will be regenerated.'))return;try{const r=await api('setUserTeamV4',[state.code,Number(b.dataset.row),team]);alert('New access code: '+r.code);await reloadUsers()}catch(err){toast(err.message,'error')}}
  async function resetCode(b){if(!confirm('Reset this user access code? The old code will stop working.'))return;try{const r=await api('resetUserCodeV4',[state.code,Number(b.dataset.row)]);alert('New access code: '+r.code);await reloadUsers()}catch(err){toast(err.message,'error')}}

  async function loadSystem(force){
    if(!force&&state.system&&state.health&&state.photoHealth){renderSystem();return}
    loading('system','Checking system health…');
    const results=await Promise.allSettled([api('getSystemV4',[state.code]),api('healthV4',[state.code]),api('photoUploadHealthV4',[state.code])]);
    if(results[0].status==='fulfilled')state.system=results[0].value;
    if(results[1].status==='fulfilled')state.health=results[1].value;
    if(results[2].status==='fulfilled')state.photoHealth=results[2].value;
    renderSystem(results.filter(x=>x.status==='rejected').map(x=>x.reason?.message||String(x.reason)));
  }
  function renderSystem(errors=[]){const s=state.system||{},h=state.health||{},p=state.photoHealth||{};$('tab_system').innerHTML=`${errors.length?`<section class="card"><h2>Some checks did not respond</h2>${errors.map(x=>`<p class="error">${esc(x)}</p>`).join('')}</section>`:''}<div class="adminGrid2"><section class="card"><h2>Backend</h2><div class="systemLine"><span>Mode</span><b>${esc(s.mode||'—')}</b></div><div class="systemLine"><span>Backend version</span><b>${esc(s.version||'—')}</b></div><div class="systemLine"><span>Active stores</span><b>${Number(s.stores||0)}</b></div><div class="systemLine"><span>Last store sync</span><b>${esc(s.lastSync||'—')}</b></div><div class="systemLine"><span>Issues</span><b>${Number(s.issues||0)}</b></div></section><section class="card"><h2>Integrity</h2><div class="systemLine"><span>Store IDs</span><b>${Number(h.storeIds||0)}/${Number(h.stores||0)}</b></div><div class="systemLine"><span>Missing Store IDs</span><b class="${Number(h.missingStoreIds||0)?'badText':'okText'}">${Number(h.missingStoreIds||0)}</b></div><div class="systemLine"><span>Duplicate Store IDs</span><b class="${(h.duplicateStoreIds||[]).length?'badText':'okText'}">${(h.duplicateStoreIds||[]).length}</b></div><div class="systemLine"><span>Safe Sync identity ready</span><b class="${h.safeSyncReady?'okText':'badText'}">${h.safeSyncReady?'YES':'NO'}</b></div></section></div><section class="card"><h2>POE Upload Health</h2><div class="systemLine"><span>Drive root</span><b class="${p.rootFolder?'okText':'badText'}">${p.rootFolder?'CONNECTED':'—'}</b></div><div class="systemLine"><span>V4_PHOTOS sheet</span><b class="${p.photosSheet?'okText':'badText'}">${p.photosSheet?'CONNECTED':'—'}</b></div>${(p.details||[]).map(x=>`<p class="error">${esc(x)}</p>`).join('')}<p class="small">High-risk Store Sync, mode switching, and Demo reset remain intentionally unavailable during active deployment.</p></section>`}

  if(state.code){login(state.code).catch(()=>{sessionStorage.removeItem('smf_admin_code');state.code='';$('adminLogin').classList.remove('hidden');$('adminApp').classList.add('hidden')})}
})();