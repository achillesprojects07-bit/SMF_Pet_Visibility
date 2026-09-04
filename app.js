(() => {
  'use strict';

  const VERSION='6.0.1-field-photo-v6';
  const API=String(window.SMF_CONFIG?.API_BASE_URL||'').replace(/\/$/,'');
  const PHOTO_API=String(window.SMF_CONFIG?.PHOTO_API_BASE_URL||'').replace(/\/$/,'');
  const $=id=>document.getElementById(id);
  const PENDING_KEY='smf_pending_photo_v6';
  const PHOTO_SESSION_KEY='smf_photo_v6_session';
  const state={code:sessionStorage.getItem('smf_code')||'',user:null,home:null,current:null,outcome:'',uploading:new Set(),pendingSync:new Set(),photoSession:null};

  $('version').textContent='v'+VERSION;

  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]))}
  function show(id){['loginView','homeView','storeView'].forEach(x=>$(x).classList.toggle('hidden',x!==id))}
  function toast(msg,type='info'){const t=$('toast');t.textContent=msg;t.dataset.type=type;t.classList.remove('hidden');clearTimeout(window.__toastTimer);window.__toastTimer=setTimeout(()=>t.classList.add('hidden'),3200)}
  function statusLabel(s){return String(s||'OPEN').toUpperCase()==='CLOSED'?'STORE CLOSED':String(s||'OPEN').toUpperCase()}
  function statusClass(s){s=String(s||'OPEN').toUpperCase();return s==='COMPLETED'?'completed':s==='INCOMPLETE'?'incomplete':s==='REFUSED'?'refused':s==='CLOSED'?'closed':'open'}
  function requireApi(){if(!API||/YOUR-WORKER/i.test(API))throw new Error('SMF API is not configured. Contact Admin.')}
  function requirePhotoApi(){if(!PHOTO_API||/YOUR-WORKER/i.test(PHOTO_API))throw new Error('SMF photo service is not configured. Contact Admin.')}
  function pendingRows(){try{const v=JSON.parse(localStorage.getItem(PENDING_KEY)||'[]');return Array.isArray(v)?v:[]}catch(_){return []}}
  function writePendingRows(rows){try{localStorage.setItem(PENDING_KEY,JSON.stringify(rows.slice(-30)))}catch(_){}}
  function savePending(rec){const rows=pendingRows().filter(x=>!(x.code===rec.code&&x.storeKey===rec.storeKey&&x.type===rec.type));rows.push(rec);writePendingRows(rows)}
  function removePending(rec){writePendingRows(pendingRows().filter(x=>!(x.code===rec.code&&x.storeKey===rec.storeKey&&x.type===rec.type)))}

  async function apiHealth(){
    requireApi();let r;
    try{r=await fetch(API+'/api/health',{method:'GET',cache:'no-store',credentials:'omit'})}catch(_){throw new Error('SMF server is unreachable. Check signal and retry.')}
    let data={};try{data=await r.json()}catch(_){throw new Error('SMF health check returned an unreadable response.')}
    if(!r.ok||data.ok===false)throw new Error(data.error||('SMF server health check failed ('+r.status+').'));
    return data;
  }

  async function apiAction(action,args=[]){
    requireApi();let r;
    try{r=await fetch(API+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,args}),cache:'no-store',credentials:'omit'})}catch(_){throw new Error('Network connection failed. Check signal and retry.')}
    let data={};try{data=await r.json()}catch(_){throw new Error('The server returned an unreadable response.')}
    if(!r.ok||data.ok===false)throw new Error(data.error||('Server error '+r.status));
    return Object.prototype.hasOwnProperty.call(data,'result')?data.result:data;
  }

  async function ensurePhotoSession(force=false){
    requirePhotoApi();
    if(!force&&state.photoSession&&state.photoSession.code===state.code&&Number(state.photoSession.expiresAt||0)>Date.now()+5*60*1000)return state.photoSession.token;
    if(!force){try{const cached=JSON.parse(localStorage.getItem(PHOTO_SESSION_KEY)||'null');if(cached&&cached.code===state.code&&cached.token&&Number(cached.expiresAt||0)>Date.now()+5*60*1000){state.photoSession=cached;return cached.token}}catch(_){}}
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);let r;
    try{r=await fetch(PHOTO_API+'/v6/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessCode:state.code}),cache:'no-store',credentials:'omit',signal:controller.signal})}
    catch(err){if(err?.name==='AbortError')throw new Error('Photo service sign-in took too long. Check signal and retry.');throw new Error('Could not connect to the photo service. Check signal and retry.')}
    finally{clearTimeout(timer)}
    let data={};try{data=await r.json()}catch(_){throw new Error('Photo service returned an unreadable sign-in response.')}
    if(!r.ok||data.ok===false||!data.sessionToken)throw new Error(data.error||'Photo service sign-in failed.');
    const rec={code:state.code,token:data.sessionToken,expiresAt:Number(data.expiresAt||0)};state.photoSession=rec;try{localStorage.setItem(PHOTO_SESSION_KEY,JSON.stringify(rec))}catch(_){}return rec.token;
  }

  function payload(){
    const beginning={},installed={},takeHome={};
    document.querySelectorAll('.inventoryRow').forEach(row=>{const k=row.dataset.item,b=Number(row.querySelector('.beg').value||0),i=Number(row.querySelector('.ins').value||0);beginning[k]=b;installed[k]=i;takeHome[k]=b-i});
    return {storeKey:state.current.store.key,beginning,installed,takeHome,notes:$('notes')?.value||'',brands:''};
  }

  async function login(code){const r=await apiAction('loginV4',[code]);if(!r?.user||r.user.role!=='FIELD')throw new Error('This workspace is for field-team access only.');state.code=code;state.user=r.user;sessionStorage.setItem('smf_code',code);await loadHome()}
  $('loginForm').addEventListener('submit',async e=>{e.preventDefault();$('loginError').textContent='';const btn=$('loginBtn');btn.disabled=true;try{await login($('codeInput').value.trim())}catch(err){$('loginError').textContent=err.message}finally{btn.disabled=false}});
  $('logoutBtn').onclick=()=>{sessionStorage.removeItem('smf_code');try{localStorage.removeItem(PHOTO_SESSION_KEY)}catch(_){}state.code='';state.user=null;state.home=null;state.current=null;state.photoSession=null;$('logoutBtn').classList.add('hidden');show('loginView')};
  $('refreshBtn').onclick=loadHome;
  $('backBtn').onclick=()=>{if(state.uploading.size||state.pendingSync.size){toast('Please wait for the current photo to finish saving/syncing.','error');return}state.current=null;show('homeView');renderHome()};

  async function loadHome(){
    try{const r=await apiAction('getFieldHomeV4',[state.code]);state.home=r;state.user={...(state.user||{}),name:r.user?.name,team:r.user?.team,role:'FIELD'};$('hello').textContent='Hello, '+(r.user?.name||'Field Team');$('teamLine').textContent=(r.user?.team||'')+' • '+r.mode;$('logoutBtn').classList.remove('hidden');show('homeView');renderHome()}
    catch(err){if(/access code|not authorized|inactive/i.test(err.message)){sessionStorage.removeItem('smf_code');state.code='';show('loginView')}else toast(err.message,'error')}
  }

  function renderHome(){
    const stores=state.home?.stores||[],days=state.home?.days||[...new Set(stores.map(s=>s.displayDay||s.day))];
    const firstDay=days.find(d=>(state.home?.dayStatus?.[d]?.open||0)>0)||days[0]||'';
    const nav=`<section class="card quickNav"><div class="navGrid"><label><span>Jump to day</span><select id="dayJump">${days.map(d=>`<option value="${esc(d)}" ${d===firstDay?'selected':''}>${esc(d)}</option>`).join('')}</select></label><label><span>Jump to store</span><select id="storeJump"><option value="">Choose a store…</option></select></label></div></section>`;
    const body=days.map(day=>{const rows=stores.filter(s=>(s.displayDay||s.day)===day).sort((a,b)=>(a.stop||0)-(b.stop||0)),ds=state.home?.dayStatus?.[day]||{};return `<section class="card dayCard" data-day-section="${esc(day)}"><div class="dayHeader"><div><h2>${esc(day)}</h2><div class="small">${Number(ds.finalized||0)} of ${rows.length} visits finalized</div></div>${ds.submitted?`<span class="badge completed">✓ DAY SUBMITTED</span>`:`<button class="secondary submitDay" data-day="${esc(day)}" ${Number(ds.open||0)>0?'disabled':''}>SUBMIT DAY</button>`}</div><div class="storeList">${rows.map(s=>{const raw=s.outcome==='NOT STARTED'?'OPEN':s.outcome;return `<button class="storeRow" data-key="${esc(s.key)}"><span class="storeText"><b>${esc(s.name)}</b><span>${esc(s.area)} • Stop ${esc(s.stop)} • ${esc(s.category)}</span></span><span class="badge ${statusClass(raw)}">${esc(statusLabel(raw))}</span></button>`}).join('')}</div></section>`}).join('')||'<div class="card">No stores assigned.</div>';
    $('days').innerHTML=nav+body;document.querySelectorAll('.storeRow').forEach(b=>b.onclick=()=>openStore(b.dataset.key));document.querySelectorAll('.submitDay').forEach(b=>b.onclick=()=>submitDay(b.dataset.day));
    const dayJump=$('dayJump'),storeJump=$('storeJump');const fillStoreJump=day=>{const rows=stores.filter(s=>(s.displayDay||s.day)===day).sort((a,b)=>(a.stop||0)-(b.stop||0));storeJump.innerHTML='<option value="">Choose a store…</option>'+rows.map(s=>`<option value="${esc(s.key)}">${esc('Stop '+s.stop+' — '+s.name)}</option>`).join('')};
    if(dayJump&&storeJump){fillStoreJump(dayJump.value);dayJump.onchange=()=>{fillStoreJump(dayJump.value);const section=[...document.querySelectorAll('[data-day-section]')].find(x=>x.dataset.daySection===dayJump.value);if(section)section.scrollIntoView({behavior:'smooth',block:'start'})};storeJump.onchange=()=>{if(storeJump.value)openStore(storeJump.value)}}
  }

  async function submitDay(day){if(!confirm('Submit '+day+'? This confirms every store visit for this day is finalized.'))return;try{await apiAction('submitDayV4',[state.code,day]);toast('Deployment day submitted ✓','success');await loadHome()}catch(err){toast(err.message,'error')}}
  async function openStore(key){show('storeView');$('storeBody').innerHTML='<div class="card loading">Loading store…</div>';try{state.current=await apiAction('getStoreV4',[state.code,key]);state.outcome='';renderStore();restorePendingForStore()}catch(err){toast(err.message,'error');show('homeView')}}

  function renderStore(){
    const r=state.current,s=r.store,p=r.poe||{},req=r.requiredPhotos||[],finalized=!!p.finalized,mats=s.materials||{},items=Object.keys(mats).filter(k=>Number(mats[k]||0)>0),photos=r.photos||{},groups=r.photoGroups||{},uploadedMain=req.filter(x=>photos[x.type]).length;
    const storeStatus=finalized?p.outcome:'OPEN';
    $('storeBody').innerHTML=`<section class="card storeHero"><div><h1>${esc(s.name)}</h1><div class="small">${esc(s.storeId||'')} • ${esc(s.team)} • ${esc(s.area)} • ${esc(s.category)}</div><p>${esc(s.address||'')}</p></div><span class="badge ${statusClass(storeStatus)}">${esc(statusLabel(storeStatus))}</span></section>
      <section class="card"><h2>Merchandising Guide</h2><h3>${esc(r.guide?.title||'Execution Guide')}</h3><ol class="guide">${(r.guide?.steps||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ol></section>
      <section class="card"><h2>Inventory</h2><div class="small">Remaining = Beginning − Installed</div><div class="inventoryHead"><span>Item</span><span>Beginning</span><span>Installed</span><span>Remaining</span></div>${items.map(k=>{const alloc=Number(mats[k]||0),b=Object.prototype.hasOwnProperty.call(p.beginning||{},k)?Number(p.beginning[k]):alloc,i=Object.prototype.hasOwnProperty.call(p.installed||{},k)?Number(p.installed[k]):0;return `<div class="inventoryRow" data-item="${esc(k)}" data-alloc="${alloc}"><b>${esc(k)}<small>Allocated ${alloc}</small></b><input class="beg" type="number" min="0" max="${alloc}" value="${b}" ${finalized?'disabled':''}><input class="ins" type="number" min="0" value="${i}" ${finalized?'disabled':''}><input class="rem" type="number" value="${b-i}" disabled></div>`}).join('')}</section>
      <section class="card"><h2>Notes</h2><textarea id="notes" placeholder="Add store visit notes…" ${finalized?'disabled':''}>${esc(p.notes||'')}</textarea></section>
      <section class="card"><div class="sectionHead"><div><h2>POE Photos</h2><div class="small">${uploadedMain} of ${req.length} required main photos uploaded</div></div></div><div class="photoGuide">Photos now upload directly to the existing POE Drive folder and finalize the POE record through the V6 transaction service. If metadata needs a retry, the image is never uploaded twice.</div><div class="photoGrid">${req.map(x=>photoSlot(x,photos,groups,finalized)).join('')}</div></section>
      ${finalized?`<section class="card"><h2>Final Visit Outcome</h2><div class="finalOutcome ${statusClass(p.outcome)}">${esc(statusLabel(p.outcome))}</div><div class="small">${esc(p.completedBy||'')} ${esc(p.completedAt||'')}</div></section>`:`<section class="card"><h2>Final Visit Outcome</h2><div class="small">Select only after deployment, Notes and POE are ready.</div><div class="outcomes">${['COMPLETED','INCOMPLETE','REFUSED','CLOSED'].map(x=>`<button class="outcome ${statusClass(x)}" data-outcome="${x}">${esc(statusLabel(x))}</button>`).join('')}</div><div class="stickyActions"><button id="saveDraft" class="secondary">SAVE DRAFT</button><button id="submitVisit" disabled>SUBMIT STORE VISIT</button></div></section>`}`;
    bindInventory();if(!finalized){document.querySelectorAll('.outcome').forEach(b=>b.onclick=()=>{state.outcome=b.dataset.outcome;document.querySelectorAll('.outcome').forEach(x=>x.classList.toggle('selected',x===b));updateSubmit()});$('saveDraft').onclick=saveDraft;$('submitVisit').onclick=submitVisit;req.forEach(x=>{const main=$('file_'+x.type),extra=$('file_extra_'+x.type);if(main)main.onchange=()=>uploadPhoto(x.type,main.files?.[0],false);if(extra)extra.onchange=()=>uploadPhoto(x.type,extra.files?.[0],true)});document.querySelectorAll('[data-remove-main]').forEach(b=>b.onclick=()=>removeMain(b.dataset.removeMain))}
  }

  function photoSlot(x,photos,groups,finalized){const main=photos[x.type],extras=(groups[x.type]||[]).filter(z=>String(z.type||'')!==x.type);return `<div id="slot_${esc(x.type)}" class="photoSlot ${main?'ok':''}"><div class="photoTitle"><b>${esc(x.label)}</b><span id="status_${esc(x.type)}" class="photoStatus">${main?'✓ Uploaded':'Required'}</span></div>${main?`<div class="fileName">${esc(main.name||'Main photo')}</div>`:''}${extras.length?`<div class="small">${extras.length} additional photo${extras.length===1?'':'s'} uploaded</div>`:''}${!finalized?`<label class="photoButton">${main?'Replace Main Photo':'Take / Choose Photo'}<input id="file_${esc(x.type)}" type="file" accept="image/*"></label><label class="photoButton secondaryPhoto">+ Add Another Photo<input id="file_extra_${esc(x.type)}" type="file" accept="image/*"></label>${main?`<button class="linkDanger" data-remove-main="${esc(x.type)}">Remove Main</button>`:''}<div class="progressTrack"><div id="bar_${esc(x.type)}" class="progressBar"></div></div><div id="queue_${esc(x.type)}" class="queueNote"></div>`:''}</div>`}
  function bindInventory(){document.querySelectorAll('.inventoryRow').forEach(row=>{const b=row.querySelector('.beg'),i=row.querySelector('.ins'),rem=row.querySelector('.rem'),alloc=Number(row.dataset.alloc||0);const calc=()=>{const bv=Number(b.value||0),iv=Number(i.value||0),rv=bv-iv;rem.value=rv;row.classList.toggle('invalid',bv>alloc||iv>bv||rv<0)};b.oninput=calc;i.oninput=calc;calc()})}
  function updateSubmit(){if($('submitVisit'))$('submitVisit').disabled=!state.outcome||state.uploading.size>0||state.pendingSync.size>0}
  async function saveDraft(){try{await apiAction('saveStoreV4',[state.code,payload()]);toast('Draft saved ✓','success')}catch(err){toast(err.message,'error')}}
  async function submitVisit(){if(!state.outcome)return;if(state.uploading.size)return toast('Wait for all photo uploads to finish.','error');if(state.pendingSync.size)return toast('A saved photo is still finalizing its POE record. Please wait for ✓ Uploaded.','error');if(!confirm('Submit this store as '+statusLabel(state.outcome)+'?'))return;try{await apiAction('submitStoreVisitV4',[state.code,payload(),state.outcome]);toast('Store visit submitted ✓','success');await openStore(state.current.store.key)}catch(err){toast(err.message,'error')}}

  async function v6Json(path,options={},retrySession=true){
    const token=await ensurePhotoSession();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options.timeout||45000);let r;
    try{r=await fetch(PHOTO_API+path,{method:options.method||'GET',headers:{...(options.body?{'Content-Type':'application/json'}:{}),'X-SMF-Session':token,...(options.headers||{})},body:options.body?JSON.stringify(options.body):undefined,cache:'no-store',credentials:'omit',signal:controller.signal})}
    catch(err){if(err?.name==='AbortError')throw new Error('Photo service took too long. Check signal and retry.');throw new Error('Could not reach the photo service. Check signal and retry.')}
    finally{clearTimeout(timer)}
    let data={};try{data=await r.json()}catch(_){throw new Error('Photo service returned an unreadable response.')}
    if((r.status===400||r.status===401)&&retrySession&&/session/i.test(String(data.error||''))){await ensurePhotoSession(true);return v6Json(path,options,false)}
    if(!r.ok||data.ok===false)throw new Error(data.error||('Photo service error '+r.status));return data;
  }

  async function preflightPhoto(type,file,addAnother,uploadId){return v6Json('/v6/photo/preflight',{method:'POST',body:{storeKey:state.current.store.key,photoType:type,addAnother:!!addAnother,uploadId,originalName:file.name||'photo.jpg',mime:file.type||'image/jpeg',size:Number(file.size||0)},timeout:60000})}
  async function v6Status(uploadId){return v6Json('/v6/photo/'+encodeURIComponent(uploadId)+'/status',{method:'GET',timeout:30000})}
  async function v6Sync(uploadId){return v6Json('/v6/photo/'+encodeURIComponent(uploadId)+'/sync',{method:'POST',timeout:45000})}
  function sendV6Photo(uploadId,file,onProgress){return new Promise(async(resolve,reject)=>{let token;try{token=await ensurePhotoSession()}catch(err){reject(err);return}const xhr=new XMLHttpRequest();xhr.open('PUT',PHOTO_API+'/v6/photo/'+encodeURIComponent(uploadId),true);xhr.timeout=120000;xhr.setRequestHeader('X-SMF-Session',token);xhr.setRequestHeader('Content-Type',file.type||'application/octet-stream');xhr.upload.onprogress=e=>{if(e.lengthComputable)onProgress(Math.max(1,Math.min(99,Math.round(e.loaded*100/e.total))))};xhr.onerror=()=>reject(new Error('Network connection lost during photo upload.'));xhr.ontimeout=()=>reject(new Error('Photo transfer timed out. Check signal and retry.'));xhr.onload=()=>{let data={};try{data=JSON.parse(xhr.responseText||'{}')}catch(_){}if(xhr.status>=200&&xhr.status<300&&data.ok!==false)resolve(data);else reject(new Error(data.error||('Photo upload failed (HTTP '+xhr.status+').')))};xhr.send(file)})}

  function finishPhoto(type,r,status,queue,slot,addAnother,rec){
    if(rec)removePending(rec);state.pendingSync.delete(type);updateSubmit();status.textContent='✓ Uploaded';queue.textContent='Saved to POE.';slot.classList.remove('failed','uploading');slot.classList.add('ok');
    if(!addAnother){state.current.photos=state.current.photos||{};state.current.photos[type]={type,url:r.url||r.file_url||'',name:r.name||r.file_name||'Photo',fileId:r.fileId||r.file_id||''}}
    toast('Photo uploaded ✓','success');apiAction('saveStoreV4',[state.code,payload()]).catch(()=>{});
  }

  function beginMetadataSync(type,r,status,queue,slot,addAnother,restored=false){
    const rec={code:state.code,storeKey:state.current.store.key,type,addAnother:!!addAnother,uploadId:r.uploadId||r.upload_id,fileId:r.fileId||r.file_id||'',name:r.name||r.file_name||'',url:r.url||r.file_url||'',savedAt:Date.now()};if(!restored)savePending(rec);
    state.pendingSync.add(type);updateSubmit();status.textContent='✓ Saved — finalizing';queue.textContent='Photo is safely in Drive. Finalizing the POE record now; the image will not be uploaded again.';slot.classList.remove('failed','uploading');slot.classList.add('ok');
    let running=false;
    const run=async()=>{
      if(running)return;running=true;let lastErr;
      try{
        for(let attempt=0;attempt<6;attempt++){
          try{const done=await v6Sync(rec.uploadId);if(done?.status==='COMPLETE'){finishPhoto(type,done,status,queue,slot,addAnother,rec);return}}
          catch(err){lastErr=err}
          queue.textContent=navigator.onLine?'✓ Photo saved. Finishing POE record automatically…':'✓ Photo saved. Waiting for internet to finish POE record…';
          await new Promise(ok=>setTimeout(ok,1200+attempt*800));
        }
        status.textContent='✓ Saved — sync pending';queue.innerHTML='Photo is safely in Drive. Its POE record still needs to finish. <button type="button" class="linkDanger" id="retrySync_'+type+'">Retry now</button>. Do not upload the photo again.';
        const retry=$('retrySync_'+type);if(retry)retry.onclick=()=>{queue.textContent='Finishing POE record…';running=false;run()};if(lastErr)console.warn('V6 metadata sync pending',lastErr);
      }finally{running=false}
    };
    run();
  }

  function restorePendingForStore(){if(!state.current?.store?.key)return;const rows=pendingRows().filter(x=>x.code===state.code&&x.storeKey===state.current.store.key&&x.uploadId);rows.forEach(rec=>{const status=$('status_'+rec.type),queue=$('queue_'+rec.type),slot=$('slot_'+rec.type);if(status&&queue&&slot&&!state.pendingSync.has(rec.type)){beginMetadataSync(rec.type,rec,status,queue,slot,rec.addAnother,true)}})}

  async function recoverAfterUploadInterruption(uploadId){
    try{const s=await v6Status(uploadId);if(s.status==='COMPLETE')return s;if(s.status==='DRIVE_SAVED'||s.status==='METADATA_PENDING')return await v6Sync(uploadId);return null}catch(_){return null}
  }

  async function uploadPhoto(type,file,addAnother){
    if(!file)return;requirePhotoApi();if(file.size>12*1024*1024){toast('Photo is over 12 MB. Please retake it normally.','error');return}if(state.uploading.has(type)||state.pendingSync.has(type)){toast('Wait for this photo to finish.','error');return}
    const uploadId=(crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random()),slot=$('slot_'+type),status=$('status_'+type),bar=$('bar_'+type),queue=$('queue_'+type);state.uploading.add(type);updateSubmit();slot.classList.remove('failed');slot.classList.add('uploading');status.textContent='Preparing V6 upload…';queue.textContent='Checking the existing POE folder. The photo has not been sent yet.';bar.style.width='3%';
    const progress=p=>{bar.style.width=p+'%';status.textContent=(addAnother?'Uploading additional photo… ':'Uploading… ')+p+'%'};
    let stage='preflight';
    try{
      const pre=await preflightPhoto(type,file,addAnother,uploadId);stage='upload';if(pre.status==='COMPLETE'){bar.style.width='100%';finishPhoto(type,pre,status,queue,slot,addAnother);return}status.textContent=addAnother?'Uploading additional photo…':'Uploading…';queue.textContent='Uploading directly to the existing POE Drive folder.';bar.style.width='1%';
      let r;try{r=await sendV6Photo(uploadId,file,progress)}catch(first){queue.textContent='Connection interrupted. Checking whether Drive already saved this exact upload…';r=await recoverAfterUploadInterruption(uploadId);if(!r){await new Promise(ok=>setTimeout(ok,1500));queue.textContent='Retrying the same reserved Drive file — no duplicate will be created.';r=await sendV6Photo(uploadId,file,p=>{bar.style.width=p+'%';status.textContent='Retrying… '+p+'%'})}}
      if(!r?.ok||!r.fileId)throw new Error('V6 did not confirm the saved photo.');bar.style.width='100%';slot.classList.remove('uploading');slot.classList.add('ok');
      if(r.status==='COMPLETE'){finishPhoto(type,r,status,queue,slot,addAnother)}
      else if(r.status==='METADATA_PENDING'||r.status==='DRIVE_SAVED'){toast('Photo safely saved ✓','success');beginMetadataSync(type,{...r,uploadId},status,queue,slot,addAnother)}
      else throw new Error('V6 returned an unexpected photo status: '+String(r.status||'unknown'));
    }catch(err){slot.classList.remove('uploading');slot.classList.add('failed');bar.style.width='0%';if(stage==='preflight'){status.textContent='✕ Upload not started';queue.textContent=err.message+' The photo was not sent. Tap Take / Choose Photo to try again.';toast('Photo upload was not started','error')}else{const recovered=await recoverAfterUploadInterruption(uploadId);if(recovered?.status==='COMPLETE'){bar.style.width='100%';finishPhoto(type,recovered,status,queue,slot,addAnother)}else if(recovered&&(recovered.status==='METADATA_PENDING'||recovered.status==='DRIVE_SAVED')){bar.style.width='100%';beginMetadataSync(type,{...recovered,uploadId},status,queue,slot,addAnother)}else{status.textContent='✕ NOT uploaded';queue.textContent=err.message+' Choose the photo again to retry.';toast('Photo NOT uploaded','error')}}}
    finally{state.uploading.delete(type);updateSubmit()}
  }

  async function removeMain(type){if(!confirm('Remove this main POE photo? The physical Drive file will be preserved.'))return;try{await apiAction('removePhotoV4',[state.code,{storeKey:state.current.store.key,photoType:type}]);toast('Main photo removed from active POE','success');await openStore(state.current.store.key)}catch(err){toast(err.message,'error')}}

  window.addEventListener('online',()=>{if(state.current)restorePendingForStore()});
  if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
  if(state.code){login(state.code).catch(()=>{sessionStorage.removeItem('smf_code');state.code='';show('loginView')})}else show('loginView');
})();