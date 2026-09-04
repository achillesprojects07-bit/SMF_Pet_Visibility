(() => {
  'use strict';
  const API=String(window.SMF_CONFIG?.API_BASE_URL||'').replace(/\/$/,'');
  const code=sessionStorage.getItem('smf_client_code')||'';
  const $=id=>document.getElementById(id);
  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]))}
  function label(s){s=String(s||'NOT STARTED').toUpperCase();return s==='CLOSED'?'STORE CLOSED':s==='NOT STARTED'?'OPEN':s}
  function cls(s){s=String(s||'OPEN').toUpperCase();return s==='COMPLETED'?'completed':s==='INCOMPLETE'?'incomplete':s==='REFUSED'?'refused':s==='CLOSED'?'closed':'open'}
  async function api(action,args=[]){
    let r;try{r=await fetch(API+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,args}),cache:'no-store',credentials:'omit'})}catch(_){throw new Error('Network connection failed. Check signal and retry.')}
    let d={};try{d=await r.json()}catch(_){throw new Error('Server returned an unreadable response.')}
    if(!r.ok||d.ok===false)throw new Error(d.error||('Server error '+r.status));
    return Object.prototype.hasOwnProperty.call(d,'result')?d.result:d;
  }
  async function load(){
    $('clientRefresh').disabled=true;$('clientBody').innerHTML='<section class="card loading">Loading deployment report…</section>';
    try{const d=await api('getClientDashboardV4',[code]);render(d)}catch(e){$('clientBody').innerHTML='<section class="card error">'+esc(e.message)+'</section>'}finally{$('clientRefresh').disabled=false}
  }
  function render(d){
    const stores=d.stores||[];
    $('clientBody').innerHTML=`
      <div class="metricGrid">
        <div class="metric total"><b>${Number(d.total||0)}</b><span>Total Stores</span></div>
        <div class="metric completed"><b>${Number(d.completed||0)}</b><span>Completed</span></div>
        <div class="metric incomplete"><b>${Number(d.incomplete||0)}</b><span>Incomplete</span></div>
        <div class="metric refused"><b>${Number(d.refused||0)}</b><span>Refused</span></div>
        <div class="metric closed"><b>${Number(d.closed||0)}</b><span>Store Closed</span></div>
        <div class="metric open"><b>${Number(d.notStarted||0)}</b><span>Not Started</span></div>
      </div>
      <section class="card"><div class="sectionTitle"><div><h2>Deployment Progress</h2><div class="small">Read-only live status</div></div><b>${Number(d.progressPct||0)}%</b></div><div class="progressTrack" style="height:12px"><div class="progressBar" style="width:${Number(d.progressPct||0)}%"></div></div></section>
      <section class="card"><div class="sectionTitle"><h2>Stores</h2><span class="small">Click a store to review its POE.</span></div><div class="filterBar"><input id="clientSearch" placeholder="Search store or area"><select id="clientStatus"><option value="">All statuses</option><option>COMPLETED</option><option>INCOMPLETE</option><option>REFUSED</option><option value="CLOSED">STORE CLOSED</option><option value="NOT STARTED">NOT STARTED</option></select></div><div id="clientStoreTable"></div></section>
      <div id="clientStoreDetail"></div>`;
    const paint=()=>{const q=$('clientSearch').value.toLowerCase(),st=$('clientStatus').value;const rows=stores.filter(x=>(!q||(x.name+' '+x.area).toLowerCase().includes(q))&&(!st||x.status===st));$('clientStoreTable').innerHTML=`<div class="adminTableCard"><table class="adminTable"><thead><tr><th>Store</th><th>Team</th><th>Day</th><th>Area</th><th>Status</th></tr></thead><tbody>${rows.map(x=>`<tr class="clientStoreRow" data-key="${esc(x.key)}" style="cursor:pointer"><td><b>${esc(x.name)}</b><div class="small">Stop ${esc(x.stop)} • ${esc(x.category)}</div></td><td>${esc(x.team)}</td><td>${esc(x.day)}</td><td>${esc(x.area)}</td><td><span class="statusDot ${cls(x.status)}"></span><b>${esc(label(x.status))}</b></td></tr>`).join('')}</tbody></table></div>`;document.querySelectorAll('.clientStoreRow').forEach(r=>r.onclick=()=>openStore(r.dataset.key))};
    $('clientSearch').oninput=paint;$('clientStatus').onchange=paint;paint();
  }
  async function openStore(key){
    $('clientStoreDetail').innerHTML='<section class="card loading">Loading POE…</section>';
    try{const r=await api('getClientStoreV4',[code,key]),s=r.store||{},pics=Object.keys(r.photoGroups||{}).flatMap(k=>(r.photoGroups[k]||[]).map(x=>({base:k,...x})));$('clientStoreDetail').innerHTML=`<section class="card"><div class="sectionTitle"><div><h2>${esc(s.name)}</h2><div class="small">${esc(s.team)} • ${esc(s.area)} • ${esc(s.category)}</div></div><span class="badge ${cls(r.status)}">${esc(label(r.status))}</span></div><p class="small">${esc(s.address||'')}</p><h3>Notes</h3><p>${esc(r.notes||'—')}</p>${pics.length?`<h3>POE Photos (${pics.length})</h3><div class="photoThumbs">${pics.map(x=>`<a class="photoThumb" href="${esc(x.url||'#')}" target="_blank" rel="noopener"><img src="${esc(x.previewUrl||x.url||'')}" alt="${esc(x.base)}"><b>${esc(x.base)}</b><div class="small">${esc(x.uploadedAt||'')}</div></a>`).join('')}</div>`:'<div class="emptyState">No active POE photos.</div>'}</section>`}catch(e){$('clientStoreDetail').innerHTML='<section class="card error">'+esc(e.message)+'</section>'}
  }
  $('clientRefresh').onclick=load;
  $('clientLogout').onclick=()=>{sessionStorage.removeItem('smf_client_code');location.replace('./')};
  load();
})();
