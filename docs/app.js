(() => {
  'use strict';
  const VERSION='5.0.0-field-pilot';
  const API=(window.SMF_CONFIG&&window.SMF_CONFIG.API_BASE_URL||'').replace(/\/$/,'');
  const $=id=>document.getElementById(id);
  const state={token:sessionStorage.getItem('smf_token')||'',user:null,home:null,current:null,photos:{},uploading:new Set(),outcome:''};

  $('version').textContent='v'+VERSION;
  function show(id){['loginView','homeView','storeView'].forEach(x=>$(x).classList.toggle('hidden',x!==id))}
  function toast(msg){$('toast').textContent=msg;$('toast').classList.remove('hidden');setTimeout(()=>$('toast').classList.add('hidden'),2600)}
  function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function statusLabel(s){return s==='CLOSED'?'STORE CLOSED':s}
  function requireApi(){if(!API)throw new Error('v5 API is not configured yet. Keep using the current field app until the pilot API is connected.')}
  async function api(path,opt={}){
    requireApi();
    const headers=new Headers(opt.headers||{});
    if(state.token)headers.set('Authorization','Bearer '+state.token);
    if(opt.body && !(opt.body instanceof FormData) && typeof opt.body!=='string'){
      headers.set('Content-Type','application/json');
      opt.body=JSON.stringify(opt.body);
    }
    const r=await fetch(API+path,{...opt,headers});
    let data={};try{data=await r.json()}catch(_){ }
    if(!r.ok)throw new Error(data.error||('Request failed ('+r.status+')'));
    return data;
  }

  $('loginForm').addEventListener('submit',async e=>{
    e.preventDefault();$('loginError').textContent='';
    try{
      const r=await api('/v1/login',{method:'POST',body:{code:$('codeInput').value.trim()}});
      state.token=r.token;state.user=r.user;sessionStorage.setItem('smf_token',r.token);$('logoutBtn').classList.remove('hidden');
      await loadHome();
    }catch(err){$('loginError').textContent=err.message}
  });
  $('logoutBtn').onclick=()=>{sessionStorage.clear();state.token='';state.user=null;$('logoutBtn').classList.add('hidden');show('loginView')};
  $('refreshBtn').onclick=loadHome;$('backBtn').onclick=()=>{show('homeView');renderHome()};

  async function loadHome(){
    try{
      const r=await api('/v1/field/home');
      state.home=r;state.user=r.user;$('hello').textContent='Hello, '+r.user.name;$('teamLine').textContent=r.user.team+' • '+r.mode;
      $('logoutBtn').classList.remove('hidden');show('homeView');renderHome();
    }catch(err){
      if(/token|auth|expired|unauthorized/i.test(err.message)){sessionStorage.clear();state.token='';show('loginView')}
      else toast(err.message);
    }
  }
  function renderHome(){
    const stores=state.home?.stores||[];
    const days=[...new Set(stores.map(s=>s.displayDay||s.day))];
    $('days').innerHTML=days.map(day=>{
      const rows=stores.filter(s=>(s.displayDay||s.day)===day).sort((a,b)=>(a.stop||0)-(b.stop||0));
      const final=rows.filter(s=>s.finalized).length;
      const ds=state.home?.dayStatus?.[day]||{submitted:false};
      return `<div class="card"><div class="dayTitle"><div><h2>${esc(day)}</h2><div class="small">${final} of ${rows.length} visits finalized</div></div>${ds.submitted?`<span class="badge done">✓ DAY SUBMITTED</span>`:`<button class="submitDayBtn secondary" data-day="${esc(day)}" ${final!==rows.length?'disabled':''}>SUBMIT DAY</button>`}</div>${rows.map(s=>`<button class="storeRow" data-key="${esc(s.key)}"><span style="flex:1"><b>${esc(s.name)}</b><span class="meta">${esc(s.area)} • Stop ${esc(s.stop)} • ${esc(s.category)}</span></span><span class="badge ${s.finalized?'done':''}">${esc(statusLabel(s.outcome||'OPEN'))}</span></button>`).join('')}</div>`;
    }).join('');
    document.querySelectorAll('.storeRow').forEach(b=>b.onclick=()=>openStore(b.dataset.key));
    document.querySelectorAll('.submitDayBtn').forEach(b=>b.onclick=()=>submitDay(b.dataset.day));
  }

  async function submitDay(day){
    try{
      if(!confirm('Submit '+day+'? This confirms every store visit for the day is finalized.'))return;
      await api('/v1/field/day/submit',{method:'POST',body:{day}});
      toast('Deployment day submitted ✓');await loadHome();
    }catch(err){toast(err.message)}
  }

  async function openStore(key){
    try{
      const r=await api('/v1/field/store/'+encodeURIComponent(key));
      state.current=r;state.photos=r.photos||{};state.outcome='';show('storeView');renderStore();
    }catch(err){toast(err.message)}
  }

  function renderStore(){
    const r=state.current,s=r.store,p=r.poe||{},req=r.photoRequirements||[],materials=s.materials||{};
    const inv=p.inventory||{beginning:{},installed:{},remaining:{}};
    const finalized=!!p.finalized;
    const rows=Object.keys(materials).filter(k=>Number(materials[k]||0)>0);
    $('storeBody').innerHTML=`
      <div class="card"><h1>${esc(s.name)}</h1><div class="small">${esc(s.storeId)} • ${esc(s.team)} • ${esc(s.area)} • ${esc(s.category)}</div><p>${esc(s.address||'')}</p></div>
      <div class="card"><h2>Inventory</h2><div class="small">Remaining = Beginning − Installed</div>
        ${rows.map(k=>{const a=Number(materials[k]||0),b=Number(inv.beginning?.[k]??a),i=Number(inv.installed?.[k]??0);return `<div class="inventoryRow" data-item="${esc(k)}"><b>${esc(k)}</b><input class="beg" type="number" min="0" value="${b}" ${finalized?'disabled':''}><input class="ins" type="number" min="0" value="${i}" ${finalized?'disabled':''}><input class="rem" type="number" value="${Math.max(0,b-i)}" disabled></div>`}).join('')}
      </div>
      <div class="card"><h2>Notes</h2><textarea id="notes" ${finalized?'disabled':''}>${esc(p.notes||'')}</textarea></div>
      <div class="card"><h2>POE Photos</h2><div class="small">Take/choose each required photo normally. Wait for ✓ Uploaded.</div><div class="photoGrid">${req.map(x=>photoSlot(x,finalized)).join('')}</div></div>
      ${finalized?`<div class="card"><h2>Final Visit Outcome</h2><div class="badge done">${esc(statusLabel(p.outcome))}</div></div>`:
      `<div class="card"><h2>Final Visit Outcome</h2><div class="outcomes">${['COMPLETED','INCOMPLETE','REFUSED','CLOSED'].map(x=>`<button class="outcome" data-outcome="${x}">${esc(statusLabel(x))}</button>`).join('')}</div></div>
       <div class="submitBar"><div class="row"><button id="saveDraft" class="secondary">SAVE DRAFT</button><button id="submitVisit" disabled>SUBMIT STORE VISIT</button></div></div>`}`;
    bindInventory();
    if(!finalized){
      document.querySelectorAll('.outcome').forEach(b=>b.onclick=()=>{state.outcome=b.dataset.outcome;document.querySelectorAll('.outcome').forEach(x=>x.classList.toggle('selected',x===b));updateSubmit()});
      $('saveDraft').onclick=saveDraft;$('submitVisit').onclick=submitVisit;
    }
    req.forEach(x=>{
      const input=$('file_'+x.type);if(input)input.onchange=()=>uploadPhoto(x.type,input.files?.[0],false);
      const extra=$('file_extra_'+x.type);if(extra)extra.onchange=()=>uploadPhoto(x.type,extra.files?.[0],true);
    });
  }

  function photoSlot(x,finalized){
    const p=state.photos[x.type];
    return `<div id="slot_${esc(x.type)}" class="photoSlot ${p?'ok':''}"><b>${esc(x.label)}</b><div id="status_${esc(x.type)}" class="photoStatus">${p?'✓ Uploaded':'Required'}</div>${p?`<div class="small">${esc(p.name||'')}</div>`:''}${!finalized?`<input id="file_${esc(x.type)}" type="file" accept="image/*"><label class="small">Additional evidence photo</label><input id="file_extra_${esc(x.type)}" type="file" accept="image/*"><div class="progressTrack"><div id="bar_${esc(x.type)}" class="progressBar"></div></div><div class="queueNote" id="queue_${esc(x.type)}"></div>`:''}</div>`;
  }

  function bindInventory(){document.querySelectorAll('.inventoryRow').forEach(row=>{const b=row.querySelector('.beg'),i=row.querySelector('.ins'),rem=row.querySelector('.rem');const calc=()=>{const bv=Number(b.value||0),iv=Number(i.value||0);rem.value=bv-iv;rem.style.color=iv>bv?'#b42318':''};b.oninput=calc;i.oninput=calc})}
  function collect(){
    const beginning={},installed={},remaining={};
    document.querySelectorAll('.inventoryRow').forEach(row=>{const k=row.dataset.item,b=Number(row.querySelector('.beg').value||0),i=Number(row.querySelector('.ins').value||0);beginning[k]=b;installed[k]=i;remaining[k]=b-i});
    return {storeKey:state.current.store.key,beginning,installed,takeHome:remaining,notes:$('notes')?.value||''};
  }
  function updateSubmit(){const pending=state.uploading.size>0;$('submitVisit').disabled=!state.outcome||pending}
  async function saveDraft(){try{await api('/v1/field/store/save',{method:'POST',body:collect()});toast('Draft saved ✓')}catch(err){toast(err.message)}}
  async function submitVisit(){
    if(!state.outcome)return;
    if(state.uploading.size)return toast('Wait for all photo uploads to finish.');
    try{const body=collect();body.status=state.outcome;await api('/v1/field/store/submit',{method:'POST',body});toast('Store visit submitted ✓');await openStore(state.current.store.key)}catch(err){toast(err.message)}
  }

  function uploadWithProgress(url,form,token,onProgress){
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();xhr.open('POST',url,true);xhr.setRequestHeader('Authorization','Bearer '+token);
      xhr.upload.onprogress=e=>{if(e.lengthComputable)onProgress(Math.round(e.loaded*100/e.total))};
      xhr.onerror=()=>reject(new Error('Network connection lost during upload.'));
      xhr.onload=()=>{let data={};try{data=JSON.parse(xhr.responseText||'{}')}catch(_){ }if(xhr.status>=200&&xhr.status<300)resolve(data);else reject(new Error(data.error||('Upload failed ('+xhr.status+')')))};
      xhr.send(form);
    });
  }

  async function uploadPhoto(type,file,addAnother){
    if(!file)return;
    if(state.uploading.has(type))return toast('Wait for the current photo upload to finish.');
    const token=(crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random());
    const form=new FormData();
    form.append('storeKey',state.current.store.key);form.append('photoType',type);form.append('addAnother',addAnother?'1':'0');form.append('uploadToken',token);form.append('photo',file,file.name||'photo.jpg');
    state.uploading.add(type);const slot=$('slot_'+type),status=$('status_'+type),bar=$('bar_'+type),queue=$('queue_'+type);
    slot.className='photoSlot uploading';status.textContent='Uploading…';queue.textContent='Keep the app open until ✓ Uploaded.';updateSubmit();
    try{
      requireApi();
      let r;
      try{r=await uploadWithProgress(API+'/v1/field/photo',form,state.token,p=>{bar.style.width=p+'%';status.textContent='Uploading… '+p+'%'})}
      catch(firstErr){queue.textContent='Connection interrupted. Retrying once with the same upload ID…';await new Promise(resolve=>setTimeout(resolve,1200));r=await uploadWithProgress(API+'/v1/field/photo',form,state.token,p=>{bar.style.width=p+'%';status.textContent='Retrying… '+p+'%'})}
      if(!r.ok)throw new Error('Server did not confirm the photo.');
      state.photos[type]=r.photo;slot.className='photoSlot ok';status.textContent='✓ Uploaded';bar.style.width='100%';queue.textContent='Saved to POE.';toast('Photo uploaded ✓');
    }catch(err){slot.className='photoSlot failed';status.textContent='✕ NOT uploaded';queue.textContent=err.message+' Choose the photo again to retry.';toast('Photo not uploaded')}
    finally{state.uploading.delete(type);updateSubmit()}
  }

  if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
  if(state.token){loadHome()}else show('loginView');
})();
