(() => {
  'use strict';
  const API=String(window.SMF_CONFIG?.API_BASE_URL||'').replace(/\/$/,'');
  const code=sessionStorage.getItem('smf_client_code')||'';
  const $=id=>document.getElementById(id);
  const state={dashboard:null,current:null};

  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]))}
  function label(s){s=String(s||'NOT STARTED').toUpperCase();return s==='CLOSED'?'STORE CLOSED':s==='NOT STARTED'?'NOT STARTED':s}
  function cls(s){s=String(s||'NOT STARTED').toUpperCase();return s==='COMPLETED'?'completed':s==='INCOMPLETE'?'incomplete':s==='REFUSED'?'refused':s==='CLOSED'?'closed':'open'}
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
    const d=state.dashboard||{},stores=d.stores||[];
    const teams=[...new Set(stores.map(x=>x.team).filter(Boolean))].sort();
    const days=[...new Set(stores.map(x=>x.day).filter(Boolean))];
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

      <section class="card clientProgressCard">
        <div class="clientSectionTitle"><div><h2>Deployment Progress</h2><div class="small">${Number(d.finalized||0)} of ${Number(d.total||0)} stores finalized</div></div><div class="clientProgressPct">${Number(d.progressPct||0)}%</div></div>
        <div class="progressTrack"><div class="progressBar" style="width:${Number(d.progressPct||0)}%"></div></div>
      </section>

      <section class="card clientReportCard">
        <div class="clientSectionTitle"><div><h2>Store Report & POE</h2><div class="small">Choose filters, then open a store to review inventory, notes and POE.</div></div><span id="clientResultCount" class="clientCount"></span></div>
        <div class="clientFilterPanel">
          <label><span>Team</span><select id="clientTeam"><option value="">All teams</option>${teams.map(x=>`<option>${esc(x)}</option>`).join('')}</select></label>
          <label><span>Deployment day</span><select id="clientDay"><option value="">All days</option>${days.map(x=>`<option>${esc(x)}</option>`).join('')}</select></label>
          <label><span>Area</span><select id="clientArea"><option value="">All areas</option>${areas.map(x=>`<option>${esc(x)}</option>`).join('')}</select></label>
          <label><span>Status</span><select id="clientStatus"><option value="">All statuses</option><option>COMPLETED</option><option>INCOMPLETE</option><option>REFUSED</option><option value="CLOSED">STORE CLOSED</option><option value="NOT STARTED">NOT STARTED</option></select></label>
        </div>
        <div class="clientSearchRow"><input id="clientSearch" placeholder="Search store name, area or category"></div>
        <div id="clientStoreTable"></div>
      </section>`;

    const paint=()=>{
      const q=$('clientSearch').value.toLowerCase(),team=$('clientTeam').value,day=$('clientDay').value,area=$('clientArea').value,st=$('clientStatus').value;
      const rows=stores.filter(x=>(!q||(x.name+' '+x.area+' '+x.category).toLowerCase().includes(q))&&(!team||x.team===team)&&(!day||x.day===day)&&(!area||x.area===area)&&(!st||x.status===st));
      $('clientResultCount').textContent=rows.length+' store'+(rows.length===1?'':'s');
      $('clientStoreTable').innerHTML=rows.length?`<div class="clientStoreList">${rows.map(x=>`<button class="clientStoreCard" data-key="${esc(x.key)}"><span class="clientStoreMain"><b>${esc(x.name)}</b><small>${esc(x.team)} • ${esc(x.day)} • Stop ${esc(x.stop)} • ${esc(x.area)} • ${esc(x.category)}</small></span><span class="clientStoreRight"><span class="clientStatusBadge ${cls(x.status)}">${esc(label(x.status))}</span><span class="viewStoreText">View store ›</span></span></button>`).join('')}</div>`:'<div class="clientEmpty">No stores match these filters.</div>';
      document.querySelectorAll('.clientStoreCard').forEach(r=>r.onclick=()=>openStore(r.dataset.key));
    };
    ['clientSearch','clientTeam','clientDay','clientArea','clientStatus'].forEach(id=>{const e=$(id);if(e)e.oninput=paint});paint();
  }

  function ensureModal(){
    let modal=$('clientStoreModal');
    if(modal)return modal;
    modal=document.createElement('div');modal.id='clientStoreModal';modal.className='clientModal hidden';
    modal.innerHTML='<div class="clientModalBackdrop" data-close="1"></div><div class="clientModalPanel"><div class="clientModalTop"><button id="clientModalClose" class="secondary">← Back to stores</button></div><div id="clientModalBody"></div></div>';
    document.body.appendChild(modal);
    modal.querySelector('[data-close]').onclick=closeModal;
    modal.querySelector('#clientModalClose').onclick=closeModal;
    return modal;
  }
  function closeModal(){const m=$('clientStoreModal');if(m){m.classList.add('hidden');document.body.classList.remove('modalOpen')}}

  async function openStore(key){
    const modal=ensureModal(),body=$('clientModalBody');
    modal.classList.remove('hidden');document.body.classList.add('modalOpen');
    body.innerHTML='<section class="clientModalLoading">Loading store…</section>';
    try{
      const r=await api('getClientStoreV4',[code,key]),s=r.store||{},m=r.materials||{},inv=r.inventory||{},pics=Object.keys(r.photoGroups||{}).flatMap(k=>(r.photoGroups[k]||[]).map(x=>({base:k,...x})));
      const items=Object.keys(m).filter(k=>Number(m[k]||0)>0);
      body.innerHTML=`
        <section class="clientStoreHero">
          <div><h1>${esc(s.name)}</h1><div class="small">${esc(s.team)} • ${esc(s.day)} • Stop ${esc(s.stop)} • ${esc(s.area)} • ${esc(s.category)}</div><p>${esc(s.address||'')}</p></div>
          <span class="clientStatusBadge ${cls(r.status)}">${esc(label(r.status))}</span>
        </section>

        <div class="clientDetailGrid">
          <section class="clientDetailSection"><h2>Visit & Notes</h2><div class="clientInfoLine"><span>Finalized</span><b>${esc(r.finalizedAt||'—')}</b></div><div class="clientInfoLine"><span>Finalized by</span><b>${esc(r.finalizedBy||'—')}</b></div><h3>Notes</h3><div class="clientNotesBox">${esc(r.notes||'—')}</div></section>
          <section class="clientDetailSection"><h2>Inventory</h2>${items.length?`<div class="clientInventoryWrap"><table class="clientInventory"><thead><tr><th>Item</th><th>Beginning</th><th>Installed</th><th>Remaining</th></tr></thead><tbody>${items.map(k=>{const b=Number(inv.beginning?.[k]??m[k]??0),i=Number(inv.installed?.[k]??0),rem=Number(inv.remaining?.[k]??(b-i));return `<tr><td><b>${esc(k)}</b></td><td>${b}</td><td>${i}</td><td>${rem}</td></tr>`}).join('')}</tbody></table></div>`:'<div class="clientEmpty">No material allocation.</div>'}</section>
        </div>

        <section class="clientDetailSection clientPoeSection">
          <div class="clientSectionTitle"><div><h2>POE</h2><div class="small">${pics.length} active photo${pics.length===1?'':'s'} for this store</div></div>${r.folderUrl?`<a href="${esc(r.folderUrl)}" target="_blank" rel="noopener" class="poeFolderButton">Open this store’s POE folder ↗</a>`:''}</div>
          ${pics.length?`<div class="clientPhotoGrid">${pics.map(x=>`<a class="clientPhoto" href="${esc(x.url||'#')}" target="_blank" rel="noopener"><img src="${esc(x.previewUrl||x.url||'')}" alt="${esc(x.base)}"><b>${esc(x.base)}</b><div class="small">${esc(x.uploadedAt||'')}</div><span class="photoOpenText">Open photo ↗</span></a>`).join('')}</div>`:'<div class="clientEmpty">No active POE photos for this store.</div>'}
        </section>`;
    }catch(e){body.innerHTML=`<section class="clientDetailSection"><h2>Could not load store</h2><p class="error">${esc(e.message)}</p></section>`}
  }

  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal()});
  $('clientRefresh').onclick=()=>{state.dashboard=null;load()};
  $('clientLogout').onclick=()=>{sessionStorage.removeItem('smf_client_code');location.replace('./')};
  load();
})();
