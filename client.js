(() => {
  'use strict';
  const API=String(window.SMF_CONFIG?.API_BASE_URL||'').replace(/\/$/,'');
  const code=sessionStorage.getItem('smf_client_code')||'';
  const $=id=>document.getElementById(id);
  const state={dashboard:null,current:null};

  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]))}
  function label(s){s=String(s||'NOT STARTED').toUpperCase();return s==='CLOSED'?'STORE CLOSED':s==='NOT STARTED'?'NOT STARTED':s}
  function cls(s){s=String(s||'NOT STARTED').toUpperCase();return s==='COMPLETED'?'completed':s==='INCOMPLETE'?'incomplete':s==='REFUSED'?'refused':s==='CLOSED'?'closed':'open'}
  function toast(msg,type='info'){const t=$('clientToast');t.textContent=msg;t.dataset.type=type;t.classList.remove('hidden');clearTimeout(window.__clientToast);window.__clientToast=setTimeout(()=>t.classList.add('hidden'),3200)}
  async function api(action,args=[]){
    let r;try{r=await fetch(API+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,args}),cache:'no-store',credentials:'omit'})}catch(_){throw new Error('Network connection failed. Check signal and retry.')}
    let d={};try{d=await r.json()}catch(_){throw new Error('Server returned an unreadable response.')}
    if(!r.ok||d.ok===false)throw new Error(d.error||('Server error '+r.status));
    return Object.prototype.hasOwnProperty.call(d,'result')?d.result:d;
  }

  async function load(){
    $('clientRefresh').disabled=true;
    if(!state.dashboard)$('clientBody').innerHTML='<section class="card loading">Loading deployment report…</section>';
    try{state.dashboard=await api('getClientDashboardV4',[code]);render()}catch(e){$('clientBody').innerHTML=`<section class="card"><h2>Could not load dashboard</h2><p class="error">${esc(e.message)}</p><button id="clientRetry" class="secondary">Retry</button></section>`;setTimeout(()=>{if($('clientRetry'))$('clientRetry').onclick=load},0)}finally{$('clientRefresh').disabled=false}
  }

  function render(){
    const d=state.dashboard||{},stores=d.stores||[],days=d.days||[];
    const teams=[...new Set(stores.map(x=>x.team).filter(Boolean))].sort();
    const dayNames=[...new Set(stores.map(x=>x.day).filter(Boolean))];
    const areas=[...new Set(stores.map(x=>x.area).filter(Boolean))].sort();
    $('clientBody').innerHTML=`
      <div class="clientMetrics">
        <div class="clientMetric total"><b>${Number(d.total||0)}</b><span>Total Stores</span></div>
        <div class="clientMetric completed"><b>${Number(d.completed||0)}</b><span>Completed</span></div>
        <div class="clientMetric incomplete"><b>${Number(d.incomplete||0)}</b><span>Incomplete</span></div>
        <div class="clientMetric refused"><b>${Number(d.refused||0)}</b><span>Refused</span></div>
        <div class="clientMetric closed"><b>${Number(d.closed||0)}</b><span>Store Closed</span></div>
        <div class="clientMetric open"><b>${Number(d.notStarted||0)}</b><span>Not Started</span></div>
      </div>

      <div class="clientGrid2">
        <section class="card">
          <div class="clientSectionTitle"><div><h2>Deployment Progress</h2><div class="small">Live read-only status from the field teams</div></div><div class="clientProgressPct">${Number(d.progressPct||0)}%</div></div>
          <div class="progressTrack" style="height:12px;margin-top:14px"><div class="progressBar" style="width:${Number(d.progressPct||0)}%"></div></div>
          <p class="small">${Number(d.finalized||0)} of ${Number(d.total||0)} stores have a final visit outcome.</p>
        </section>
        <section class="card">
          <div class="clientSectionTitle"><div><h2>Status Guide</h2><div class="small">Final store-visit outcomes</div></div></div>
          <div class="miniStatus" style="margin-top:10px">
            <span><b style="color:#176b3a">●</b> Completed</span><span><b style="color:#c3a500">●</b> Incomplete</span>
            <span><b style="color:#a32620">●</b> Refused</span><span><b style="color:#4b5563">●</b> Store Closed</span>
            <span><b style="color:#3d7fcb">●</b> Not Started</span>
          </div>
        </section>
      </div>

      <section class="card">
        <div class="clientSectionTitle"><div><h2>By Deployment Day</h2><div class="small">Both teams combined</div></div></div>
        <div class="clientDayCards" style="margin-top:12px">${days.map(x=>`<div class="clientDayCard"><h3>${esc(x.day)}</h3><div class="small">${Number(x.total||0)} stores • ${Number(x.completed||0)+Number(x.incomplete||0)+Number(x.refused||0)+Number(x.closed||0)} finalized</div><div class="miniStatus" style="margin-top:8px"><span>Completed <b>${Number(x.completed||0)}</b></span><span>Incomplete <b>${Number(x.incomplete||0)}</b></span><span>Refused <b>${Number(x.refused||0)}</b></span><span>Closed <b>${Number(x.closed||0)}</b></span><span>Not Started <b>${Number(x.notStarted||0)}</b></span></div></div>`).join('')||'<div class="clientEmpty">No deployment-day data.</div>'}</div>
      </section>

      <section class="card">
        <div class="clientSectionTitle"><div><h2>Store Report & POE</h2><div class="small">Use the filters, then click a store to review its submitted POE.</div></div><span id="clientResultCount" class="clientCount"></span></div>
        <div class="clientFilters">
          <input id="clientSearch" placeholder="Search store or area">
          <select id="clientTeam"><option value="">All teams</option>${teams.map(x=>`<option>${esc(x)}</option>`).join('')}</select>
          <select id="clientDay"><option value="">All days</option>${dayNames.map(x=>`<option>${esc(x)}</option>`).join('')}</select>
          <select id="clientArea"><option value="">All areas</option>${areas.map(x=>`<option>${esc(x)}</option>`).join('')}</select>
          <select id="clientStatus"><option value="">All statuses</option><option>COMPLETED</option><option>INCOMPLETE</option><option>REFUSED</option><option value="CLOSED">STORE CLOSED</option><option value="NOT STARTED">NOT STARTED</option></select>
        </div>
        <div id="clientStoreTable"></div>
      </section>
      <div id="clientStoreDetail" class="clientDetail"></div>`;

    const paint=()=>{
      const q=$('clientSearch').value.toLowerCase(),team=$('clientTeam').value,day=$('clientDay').value,area=$('clientArea').value,st=$('clientStatus').value;
      const rows=stores.filter(x=>(!q||(x.name+' '+x.area+' '+x.category).toLowerCase().includes(q))&&(!team||x.team===team)&&(!day||x.day===day)&&(!area||x.area===area)&&(!st||x.status===st));
      $('clientResultCount').textContent=rows.length+' store'+(rows.length===1?'':'s');
      $('clientStoreTable').innerHTML=rows.length?`<div class="clientStoreTable"><table><thead><tr><th>Store</th><th>Team</th><th>Day</th><th>Area</th><th>Status</th><th>Finalized</th></tr></thead><tbody>${rows.map(x=>`<tr class="clientStoreRow" data-key="${esc(x.key)}"><td><b>${esc(x.name)}</b><div class="small">Stop ${esc(x.stop)} • ${esc(x.category)}</div></td><td>${esc(x.team)}</td><td>${esc(x.day)}</td><td>${esc(x.area)}</td><td><span class="clientStatusBadge ${cls(x.status)}">${esc(label(x.status))}</span></td><td>${esc(x.completedAt||'—')}</td></tr>`).join('')}</tbody></table></div>`:'<div class="clientEmpty">No stores match these filters.</div>';
      document.querySelectorAll('.clientStoreRow').forEach(r=>r.onclick=()=>openStore(r.dataset.key));
    };
    ['clientSearch','clientTeam','clientDay','clientArea','clientStatus'].forEach(id=>{const e=$(id);if(e)e.oninput=paint});paint();
  }

  async function openStore(key){
    const detail=$('clientStoreDetail');detail.innerHTML='<section class="card loading">Loading store POE…</section>';detail.scrollIntoView({behavior:'smooth',block:'start'});
    try{
      const r=await api('getClientStoreV4',[code,key]),s=r.store||{},m=r.materials||{},inv=r.inventory||{},pics=Object.keys(r.photoGroups||{}).flatMap(k=>(r.photoGroups[k]||[]).map(x=>({base:k,...x})));
      const items=Object.keys(m).filter(k=>Number(m[k]||0)>0);
      detail.innerHTML=`<section class="card">
        <div class="clientDetailHeader"><div><h2 style="margin:0 0 5px">${esc(s.name)}</h2><div class="small">${esc(s.team)} • ${esc(s.day)} • Stop ${esc(s.stop)} • ${esc(s.area)} • ${esc(s.category)}</div></div><span class="clientStatusBadge ${cls(r.status)}">${esc(label(r.status))}</span></div>
        <p class="small">${esc(s.address||'')}</p>
        <div class="clientDetailGrid">
          <div><h3>Visit Summary</h3><div class="clientInfoLine"><span>Finalized</span><b>${esc(r.finalizedAt||'—')}</b></div><div class="clientInfoLine"><span>Finalized by</span><b>${esc(r.finalizedBy||'—')}</b></div><h3>Notes</h3><p>${esc(r.notes||'—')}</p></div>
          <div><h3>Material Inventory</h3>${items.length?`<table class="clientInventory"><thead><tr><th>Item</th><th>Beginning</th><th>Installed</th><th>Remaining</th></tr></thead><tbody>${items.map(k=>{const b=Number(inv.beginning?.[k]??m[k]??0),i=Number(inv.installed?.[k]??0),rem=Number(inv.remaining?.[k]??(b-i));return `<tr><td>${esc(k)}</td><td>${b}</td><td>${i}</td><td>${rem}</td></tr>`}).join('')}</tbody></table>`:'<div class="small">No material allocation.</div>'}</div>
        </div>
        <div class="clientSectionTitle" style="margin-top:16px"><h3>POE Photos (${pics.length})</h3>${r.folderUrl?`<a href="${esc(r.folderUrl)}" target="_blank" rel="noopener" class="small">Open store POE folder</a>`:''}</div>
        ${pics.length?`<div class="clientPhotoGrid">${pics.map(x=>`<a class="clientPhoto" href="${esc(x.url||'#')}" target="_blank" rel="noopener"><img src="${esc(x.previewUrl||x.url||'')}" alt="${esc(x.base)}"><b>${esc(x.base)}</b><div class="small">${esc(x.uploadedAt||'')}</div></a>`).join('')}</div>`:'<div class="clientEmpty">No active POE photos for this store.</div>'}
        <div style="margin-top:14px"><button id="clientCloseDetail" class="clientBackTop">Close Store Detail</button></div>
      </section>`;
      $('clientCloseDetail').onclick=()=>{detail.innerHTML='';window.scrollTo({top:Math.max(0,detail.offsetTop-300),behavior:'smooth'})};
    }catch(e){detail.innerHTML=`<section class="card"><h2>Could not load store</h2><p class="error">${esc(e.message)}</p></section>`}
  }

  $('clientRefresh').onclick=()=>{state.dashboard=null;load()};
  $('clientLogout').onclick=()=>{sessionStorage.removeItem('smf_client_code');location.replace('./')};
  load();
})();
