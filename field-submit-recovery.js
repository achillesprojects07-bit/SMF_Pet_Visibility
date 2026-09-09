(() => {
  'use strict';

  const API=String(window.SMF_CONFIG?.API_BASE_URL||'').replace(/\/$/,'');
  const $=id=>document.getElementById(id);
  let submitting=false;

  function toast(msg,type='info',ms=7000){
    const t=$('toast');
    if(!t)return;
    t.textContent=msg;
    t.dataset.type=type;
    t.classList.remove('hidden');
    clearTimeout(window.__smfSubmitRecoveryToast);
    window.__smfSubmitRecoveryToast=setTimeout(()=>t.classList.add('hidden'),ms);
  }

  async function apiAction(action,args=[]){
    if(!API)throw new Error('SMF API is not configured.');
    let r;
    try{
      r=await fetch(API+'/api/action',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action,args}),cache:'no-store',credentials:'omit'
      });
    }catch(_){throw new Error('Network connection failed. Check signal and retry.');}
    let data={};
    try{data=await r.json()}catch(_){throw new Error('The server returned an unreadable response.');}
    if(!r.ok||data.ok===false)throw new Error(data.error||('Server error '+r.status));
    return Object.prototype.hasOwnProperty.call(data,'result')?data.result:data;
  }

  function selectedOutcome(){return String(document.querySelector('.outcome.selected')?.dataset?.outcome||'').toUpperCase();}
  function activePhotoUpload(){return !!document.querySelector('.photoSlot.uploading');}
  function visiblePhotoSyncPending(){return [...document.querySelectorAll('.photoStatus')].some(el=>/saved\s*[—-]\s*(finalizing|sync pending)/i.test(String(el.textContent||'')));}
  function currentStoreId(){const line=document.querySelector('.storeHero .small');return line?String(line.textContent||'').split('•')[0].trim():'';}

  function currentPayload(storeKey){
    const beginning={},installed={},takeHome={};
    document.querySelectorAll('.inventoryRow').forEach(row=>{
      const key=row.dataset.item,b=Number(row.querySelector('.beg')?.value||0),i=Number(row.querySelector('.ins')?.value||0);
      beginning[key]=b;installed[key]=i;takeHome[key]=b-i;
    });
    return {storeKey,beginning,installed,takeHome,notes:String($('notes')?.value||''),brands:''};
  }

  async function resolveLiveStore(code){
    const storeId=currentStoreId();
    if(!storeId)throw new Error('Could not identify this store. Go back to the schedule and reopen it.');
    const home=await apiAction('getFieldHomeV4',[code]);
    const stores=Array.isArray(home?.stores)?home.stores:[];
    const match=stores.find(s=>String(s.storeId||'').trim()===storeId);
    if(!match?.key)throw new Error('Could not match this store to the live schedule. Refresh and reopen it.');
    return match;
  }

  function clearStaleLocalPending(storeKey){
    try{
      const key='smf_pending_photo_v6';
      const rows=JSON.parse(localStorage.getItem(key)||'[]');
      if(!Array.isArray(rows))return;
      const kept=rows.filter(r=>String(r.storeKey||'')!==String(storeKey||''));
      if(kept.length!==rows.length)localStorage.setItem(key,JSON.stringify(kept));
    }catch(_){ }
  }

  function enableSubmitAfterOutcome(){
    const btn=$('submitVisit');
    if(!btn||!selectedOutcome()||activePhotoUpload())return;
    // This recovery handler owns final submit. Do not let stale in-memory V6 sync flags
    // leave a genuinely visited store permanently OPEN once its uploaded POE is already visible.
    btn.disabled=false;
    btn.dataset.submitRecovery='2';
  }

  document.addEventListener('click',e=>{
    if(e.target.closest('.outcome'))setTimeout(enableSubmitAfterOutcome,0);
  },true);

  // Own ALL field final-submit clicks. The former patch only handled a button that stayed
  // disabled, so normal-looking clicks could still fall through to app.js and be rejected
  // by stale pendingSync state. We now use the same production API transaction directly.
  document.addEventListener('click',async e=>{
    const btn=e.target.closest('#submitVisit');
    if(!btn)return;
    e.preventDefault();e.stopImmediatePropagation();
    if(submitting)return;

    const outcome=selectedOutcome();
    if(!outcome)return toast('Choose the final store status first.','error');
    if(activePhotoUpload())return toast('Wait for the current photo upload to finish.','error');

    const code=String(sessionStorage.getItem('smf_code')||'').trim();
    if(!code)return toast('Your field session expired. Sign in again.','error');

    const notes=String($('notes')?.value||'').trim();
    if(outcome!=='COMPLETED'&&!notes)return toast(outcome+' requires visit notes before submission.','error');

    if(!confirm('Submit this store as '+(outcome==='CLOSED'?'STORE CLOSED':outcome)+'?'))return;

    submitting=true;const oldText=btn.textContent;btn.disabled=true;btn.textContent='SUBMITTING…';
    try{
      const store=await resolveLiveStore(code);
      // If the UI no longer shows a photo actively finalizing, remove only stale local retry
      // markers for this store. This does not delete or modify any Drive photo or V4_PHOTOS row.
      if(!visiblePhotoSyncPending())clearStaleLocalPending(store.key);
      const p=currentPayload(store.key);
      const result=await apiAction('submitStoreVisitV4',[code,p,outcome]);
      if(result&&result.ok===false)throw new Error(result.error||'Store submission failed.');
      toast('Store visit submitted ✓','success',3500);
      setTimeout(()=>location.reload(),700);
    }catch(err){
      btn.disabled=false;btn.textContent=oldText;submitting=false;
      const msg=String(err?.message||'Store submission failed. Please retry.');
      toast(msg,'error',12000);
      console.error('SMF final submit failed',msg);
    }
  },true);

  const observer=new MutationObserver(()=>enableSubmitAfterOutcome());
  observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','disabled']});
})();
