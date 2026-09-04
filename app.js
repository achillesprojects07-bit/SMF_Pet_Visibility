(() => {
  'use strict';

  const VERSION='5.0.0-field-pilot';
  const API=String(window.SMF_CONFIG?.API_BASE_URL||'').replace(/\/$/,'');
  const $=id=>document.getElementById(id);
  const state={code:sessionStorage.getItem('smf_code')||'',user:null,home:null,current:null,outcome:'',uploading:new Set()};

  $('version').textContent='v'+VERSION;

  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function show(id){['loginView','homeView','storeView'].forEach(x=>$(x).classList.toggle('hidden',x!==id))}
  function toast(msg,type='info'){const t=$('toast');t.textContent=msg;t.dataset.type=type;t.classList.remove('hidden');clearTimeout(window.__toastTimer);window.__toastTimer=setTimeout(()=>t.classList.add('hidden'),3200)}
  function statusLabel(s){return String(s||'OPEN').toUpperCase()==='CLOSED'?'STORE CLOSED':String(s||'OPEN').toUpperCase()}
  function requireApi(){if(!API||/YOUR-WORKER/i.test(API))throw new Error('SMF v5 API is not configured yet. Please continue using the current field app until Admin completes setup.')}

  async function apiAction(action,args=[]){
    requireApi();
    let r;
    try{r=await fetch(API+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,args}),cache:'no-store',credentials:'omit'})}
    catch(_){throw new Error('Network connection failed. Check signal and retry.')}
    let data={};try{data=await r.json()}catch(_){throw new Error('The server returned an unreadable response.')}
    if(!r.ok||data.ok===false)throw new Error(data.error||('Server error '+r.status));
    return Object.prototype.hasOwnProperty.call(data,'result')?data.result:data;
  }

  function payload(){
    const beginning={},installed={},takeHome={};
    document.querySelectorAll('.inventoryRow').forEach(row=>{
      const k=row.dataset.item,b=Number(row.querySelector('.beg').value||0),i=Number(row.querySelector('.ins').value||0);
      beginning[k]=b;installed[k]=i;takeHome[k]=b-i;
    });
    return {storeKey:state.current.store.key,beginning,installed,takeHome,notes:$('notes')?.value||'',brands:''};
  }

  async function login(code){
    const r=await apiAction('loginV4',[code]);
    if(!r?.user||r.user.role!=='FIELD')throw new Error('This v5 pilot is for field-team access only.');
    state.code=code;state.user=r.user;sessionStorage.setItem('smf_code',code);await loadHome();
  }

  $('loginForm').addEventListener('submit',async e=>{
    e.preventDefault();$('loginError').textContent='';const btn=$('loginBtn');btn.disabled=true;
    try{await login($('codeInput').value.trim())}catch(err){$('loginError').textContent=err.message}finally{btn.disabled=false}
  });

  $('logoutBtn').onclick=()=>{sessionStorage.removeItem('smf_code');state.code='';state.user=null;state.home=null;state.current=null;$('logoutBtn').classList.add('hidden');show('loginView')};
  $('refreshBtn').onclick=loadHome;
  $('backBtn').onclick=()=>{state.current=null;show('homeView');renderHome()};

  async function loadHome(){
    try{
      const r=await apiAction('getFieldHomeV4',[state.code]);state.home=r;state.user={...(state.user||{}),name:r.user?.name,team:r.user?.team,role:'FIELD'};
      $('hello').textContent='Hello, '+(r.user?.name||'Field Team');$('teamLine').textContent=(r.user?.team||'')+' • '+r.mode;$('logoutBtn').classList.remove('hidden');show('homeView');renderHome();
    }catch(err){if(/access code|not authorized|inactive/i.test(err.message)){sessionStorage.removeItem('smf_code');state.code='';show('loginView')}else toast(err.message,'error')}
  }

  function renderHome(){
    const stores=state.home?.stores||[],days=state.home?.days||[...new Set(stores.map(s=>s.displayDay||s.day))];
    $('days').innerHTML=days.map(day=>{
      const rows=stores.filter(s=>(s.displayDay||s.day)===day).sort((a,b)=>(a.stop||0)-(b.stop||0)),ds=state.home?.dayStatus?.[day]||{};
      return `<section class="card"><div class="dayHeader"><div><h2>${esc(day)}</h2><div class="small">${Number(ds.finalized||0)} of ${rows.length} visits finalized</div></div>${ds.submitted?`<span class="badge done">✓ DAY SUBMITTED</span>`:`<button class="secondary submitDay" data-day="${esc(day)}" ${Number(ds.open||0)>0?'disabled':''}>SUBMIT DAY</button>`}</div><div class="storeList">${rows.map(s=>`<button class="storeRow" data-key="${esc(s.key)}"><span class="storeText"><b>${esc(s.name)}</b><span>${esc(s.area)} • Stop ${esc(s.stop)} • ${esc(s.category)}</span></span><span class="badge ${s.finalized?'done':''}">${esc(statusLabel(s.outcome==='NOT STARTED'?'OPEN':s.outcome))}</span></button>`).join('')}</div></section>`;
    }).join('')||'<div class="card">No stores assigned.</div>';
    document.querySelectorAll('.storeRow').forEach(b=>b.onclick=()=>openStore(b.dataset.key));
    document.querySelectorAll('.submitDay').forEach(b=>b.onclick=()=>submitDay(b.dataset.day));
  }

  async function submitDay(day){
    if(!confirm('Submit '+day+'? This confirms every store visit for this day is finalized.'))return;
    try{await apiAction('submitDayV4',[state.code,day]);toast('Deployment day submitted ✓','success');await loadHome()}catch(err){toast(err.message,'error')}
  }

  async function openStore(key){
    show('storeView');$('storeBody').innerHTML='<div class="card loading">Loading store…</div>';
    try{state.current=await apiAction('getStoreV4',[state.code,key]);state.outcome='';renderStore()}catch(err){toast(err.message,'error');show('homeView')}
  }

  function renderStore(){
    const r=state.current,s=r.store,p=r.poe||{},req=r.requiredPhotos||[],finalized=!!p.finalized,mats=s.materials||{},items=Object.keys(mats).filter(k=>Number(mats[k]||0)>0),photos=r.photos||{},groups=r.photoGroups||{},uploadedMain=req.filter(x=>photos[x.type]).length;
    $('storeBody').innerHTML=`
      <section class="card storeHero"><div><h1>${esc(s.name)}</h1><div class="small">${esc(s.storeId||'')} • ${esc(s.team)} • ${esc(s.area)} • ${esc(s.category)}</div><p>${esc(s.address||'')}</p></div><span class="badge ${finalized?'done':''}">${esc(finalized?statusLabel(p.outcome):'OPEN')}</span></section>
      <section class="card"><h2>Merchandising Guide</h2><h3>${esc(r.guide?.title||'Execution Guide')}</h3><ol class="guide">${(r.guide?.steps||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ol></section>
      <section class="card"><h2>Inventory</h2><div class="small">Remaining = Beginning − Installed</div><div class="inventoryHead"><span>Item</span><span>Beginning</span><span>Installed</span><span>Remaining</span></div>${items.map(k=>{const alloc=Number(mats[k]||0),b=Object.prototype.hasOwnProperty.call(p.beginning||{},k)?Number(p.beginning[k]):alloc,i=Object.prototype.hasOwnProperty.call(p.installed||{},k)?Number(p.installed[k]):0;return `<div class="inventoryRow" data-item="${esc(k)}" data-alloc="${alloc}"><b>${esc(k)}<small>Allocated ${alloc}</small></b><input class="beg" type="number" min="0" max="${alloc}" value="${b}" ${finalized?'disabled':''}><input class="ins" type="number" min="0" value="${i}" ${finalized?'disabled':''}><input class="rem" type="number" value="${b-i}" disabled></div>`}).join('')}</section>
      <section class="card"><h2>Notes</h2><textarea id="notes" placeholder="Add store visit notes…" ${finalized?'disabled':''}>${esc(p.notes||'')}</textarea></section>
      <section class="card"><div class="sectionHead"><div><h2>POE Photos</h2><div class="small">${uploadedMain} of ${req.length} required main photos uploaded</div></div></div><div class="photoGuide">Take/choose the photo normally. Keep this page open until you see <b>✓ Uploaded</b>.</div><div class="photoGrid">${req.map(x=>photoSlot(x,photos,groups,finalized)).join('')}</div></section>
      ${finalized?`<section class="card"><h2>Final Visit Outcome</h2><div class="finalOutcome">${esc(statusLabel(p.outcome))}</div><div class="small">${esc(p.completedBy||'')} ${esc(p.completedAt||'')}</div></section>`:`<section class="card"><h2>Final Visit Outcome</h2><div class="small">Select only after deployment, Notes and POE are ready.</div><div class="outcomes">${['COMPLETED','INCOMPLETE','REFUSED','CLOSED'].map(x=>`<button class="outcome" data-outcome="${x}">${esc(statusLabel(x))}</button>`).join('')}</div><div class="stickyActions"><button id="saveDraft" class="secondary">SAVE DRAFT</button><button id="submitVisit" disabled>SUBMIT STORE VISIT</button></div></section>`}`;
    bindInventory();
    if(!finalized){
      document.querySelectorAll('.outcome').forEach(b=>b.onclick=()=>{state.outcome=b.dataset.outcome;document.querySelectorAll('.outcome').forEach(x=>x.classList.toggle('selected',x===b));updateSubmit()});
      $('saveDraft').onclick=saveDraft;$('submitVisit').onclick=submitVisit;
      req.forEach(x=>{const main=$('file_'+x.type),extra=$('file_extra_'+x.type);if(main)main.onchange=()=>uploadPhoto(x.type,main.files?.[0],false);if(extra)extra.onchange=()=>uploadPhoto(x.type,extra.files?.[0],true)});
      document.querySelectorAll('[data-remove-main]').forEach(b=>b.onclick=()=>removeMain(b.dataset.removeMain));
    }
  }

  function photoSlot(x,photos,groups,finalized){
    const main=photos[x.type],extras=(groups[x.type]||[]).filter(z=>String(z.type||'')!==x.type);
    return `<div id="slot_${esc(x.type)}" class="photoSlot ${main?'ok':''}"><div class="photoTitle"><b>${esc(x.label)}</b><span id="status_${esc(x.type)}" class="photoStatus">${main?'✓ Uploaded':'Required'}</span></div>${main?`<div class="fileName">${esc(main.name||'Main photo')}</div>`:''}${extras.length?`<div class="small">${extras.length} additional photo${extras.length===1?'':'s'} uploaded</div>`:''}${!finalized?`<label class="photoButton">${main?'Replace Main Photo':'Take / Choose Photo'}<input id="file_${esc(x.type)}" type="file" accept="image/*"></label><label class="photoButton secondaryPhoto">+ Add Another Photo<input id="file_extra_${esc(x.type)}" type="file" accept="image/*"></label>${main?`<button class="linkDanger" data-remove-main="${esc(x.type)}">Remove Main</button>`:''}<div class="progressTrack"><div id="bar_${esc(x.type)}" class="progressBar"></div></div><div id="queue_${esc(x.type)}" class="queueNote"></div>`:''}</div>`;
  }

  function bindInventory(){document.querySelectorAll('.inventoryRow').forEach(row=>{const b=row.querySelector('.beg'),i=row.querySelector('.ins'),rem=row.querySelector('.rem'),alloc=Number(row.dataset.alloc||0);const calc=()=>{const bv=Number(b.value||0),iv=Number(i.value||0),rv=bv-iv;rem.value=rv;row.classList.toggle('invalid',bv>alloc||iv>bv||rv<0)};b.oninput=calc;i.oninput=calc;calc()})}
  function updateSubmit(){if($('submitVisit'))$('submitVisit').disabled=!state.outcome||state.uploading.size>0}

  async function saveDraft(){try{await apiAction('saveStoreV4',[state.code,payload()]);toast('Draft saved ✓','success')}catch(err){toast(err.message,'error')}}
  async function submitVisit(){if(!state.outcome)return;if(state.uploading.size)return toast('Wait for all photo uploads to finish.','error');if(!confirm('Submit this store as '+statusLabel(state.outcome)+'?'))return;try{await apiAction('submitStoreVisitV4',[state.code,payload(),state.outcome]);toast('Store visit submitted ✓','success');await openStore(state.current.store.key)}catch(err){toast(err.message,'error')}}

  function photoRequestForm(type,file,addAnother,uploadToken){const f=new FormData();f.append('accessCode',state.code);f.append('storeKey',state.current.store.key);f.append('photoType',type);f.append('addAnother',addAnother?'1':'0');f.append('uploadToken',uploadToken);f.append('photoFile',file,file.name||'photo.jpg');return f}

  function sendPhoto(form,onProgress){return new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST',API+'/api/photo',true);xhr.timeout=120000;xhr.upload.onprogress=e=>{if(e.lengthComputable)onProgress(Math.max(1,Math.min(99,Math.round(e.loaded*100/e.total))))};xhr.onerror=()=>reject(new Error('Network connection lost during photo upload.'));xhr.ontimeout=()=>reject(new Error('Photo upload timed out.'));xhr.onload=()=>{let data={};try{data=JSON.parse(xhr.responseText||'{}')}catch(_){}if(xhr.status>=200&&xhr.status<300&&data.ok!==false)resolve(data.result||data);else reject(new Error(data.error||('Photo upload failed (HTTP '+xhr.status+').')))};xhr.send(form)})}

  async function uploadPhoto(type,file,addAnother){
    if(!file)return;requireApi();if(file.size>12*1024*1024){toast('Photo is over 12 MB. Please retake it normally.','error');return}if(state.uploading.has(type)){toast('Wait for this photo upload to finish.','error');return}
    const uploadToken=(crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random()),draft=payload(),slot=$('slot_'+type),status=$('status_'+type),bar=$('bar_'+type),queue=$('queue_'+type);state.uploading.add(type);updateSubmit();slot.classList.remove('failed');slot.classList.add('uploading');status.textContent=addAnother?'Uploading additional photo…':'Uploading…';queue.textContent='Keep the app open until ✓ Uploaded.';
    const progress=p=>{bar.style.width=p+'%';status.textContent=(addAnother?'Uploading additional photo… ':'Uploading… ')+p+'%'};
    try{
      let r;try{r=await sendPhoto(photoRequestForm(type,file,addAnother,uploadToken),progress)}catch(first){queue.textContent='Connection interrupted. Retrying once with the same upload ID…';await new Promise(ok=>setTimeout(ok,1200));r=await sendPhoto(photoRequestForm(type,file,addAnother,uploadToken),p=>{bar.style.width=p+'%';status.textContent='Retrying… '+p+'%'})}
      if(!r?.ok||!r.fileId)throw new Error('Server did not confirm the saved photo.');bar.style.width='100%';status.textContent='✓ Uploaded';slot.classList.remove('uploading');slot.classList.add('ok');queue.textContent='Saved to POE.';toast('Photo uploaded ✓','success');
      apiAction('saveStoreV4',[state.code,draft]).catch(err=>console.warn('Background draft save failed',err));
      if(!addAnother){state.current.photos=state.current.photos||{};state.current.photos[type]={type:r.type,url:r.url,name:r.name,fileId:r.fileId}}
    }catch(err){slot.classList.remove('uploading');slot.classList.add('failed');status.textContent='✕ NOT uploaded';queue.textContent=err.message+' Choose the photo again to retry.';bar.style.width='0%';toast('Photo NOT uploaded','error')}finally{state.uploading.delete(type);updateSubmit()}
  }

  async function removeMain(type){if(!confirm('Remove this main POE photo? The physical Drive file will be preserved.'))return;try{await apiAction('removePhotoV4',[state.code,{storeKey:state.current.store.key,photoType:type}]);toast('Main photo removed from active POE','success');await openStore(state.current.store.key)}catch(err){toast(err.message,'error')}}

  if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
  if(state.code){login(state.code).catch(()=>{sessionStorage.removeItem('smf_code');state.code='';show('loginView')})}else show('loginView');
})();
