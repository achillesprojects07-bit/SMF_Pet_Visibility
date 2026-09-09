(() => {
  'use strict';

  const API=String(window.SMF_CONFIG?.API_BASE_URL||'').replace(/\/$/,'');
  const $=id=>document.getElementById(id);

  function toast(msg,type='info'){
    const t=$('toast');
    if(!t)return;
    t.textContent=msg;
    t.dataset.type=type;
    t.classList.remove('hidden');
    clearTimeout(window.__smfSubmitRecoveryToast);
    window.__smfSubmitRecoveryToast=setTimeout(()=>t.classList.add('hidden'),4200);
  }

  async function apiAction(action,args=[]){
    if(!API)throw new Error('SMF API is not configured.');
    let r;
    try{
      r=await fetch(API+'/api/action',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action,args}),
        cache:'no-store',
        credentials:'omit'
      });
    }catch(_){
      throw new Error('Network connection failed. Check signal and retry.');
    }
    let data={};
    try{data=await r.json()}catch(_){throw new Error('The server returned an unreadable response.');}
    if(!r.ok||data.ok===false)throw new Error(data.error||('Server error '+r.status));
    return Object.prototype.hasOwnProperty.call(data,'result')?data.result:data;
  }

  function selectedOutcome(){
    return String(document.querySelector('.outcome.selected')?.dataset?.outcome||'').toUpperCase();
  }

  function activePhotoUpload(){
    return !!document.querySelector('.photoSlot.uploading');
  }

  function currentStoreId(){
    const line=document.querySelector('.storeHero .small');
    if(!line)return '';
    return String(line.textContent||'').split('•')[0].trim();
  }

  function currentPayload(storeKey){
    const beginning={},installed={},takeHome={};
    document.querySelectorAll('.inventoryRow').forEach(row=>{
      const key=row.dataset.item;
      const b=Number(row.querySelector('.beg')?.value||0);
      const i=Number(row.querySelector('.ins')?.value||0);
      beginning[key]=b;
      installed[key]=i;
      takeHome[key]=b-i;
    });
    return {
      storeKey,
      beginning,
      installed,
      takeHome,
      notes:String($('notes')?.value||''),
      brands:''
    };
  }

  async function resolveStoreKey(code){
    const storeId=currentStoreId();
    if(!storeId)throw new Error('Could not identify this store. Go back to the schedule and reopen it.');
    const home=await apiAction('getFieldHomeV4',[code]);
    const stores=Array.isArray(home?.stores)?home.stores:[];
    const match=stores.find(s=>String(s.storeId||'').trim()===storeId);
    if(!match?.key)throw new Error('Could not match this store to the live schedule. Refresh and reopen it.');
    return match.key;
  }

  function markRecoveryIfNeeded(){
    const btn=$('submitVisit');
    const outcome=selectedOutcome();
    if(!btn||!outcome)return;
    if(activePhotoUpload())return;

    // app.js normally enables this button immediately after an outcome is chosen.
    // If it remains disabled, the field session is stuck on stale photo-sync state.
    // Enable only this blocked case; normal submissions remain owned by app.js.
    window.setTimeout(()=>{
      const live=$('submitVisit');
      if(!live||!selectedOutcome()||activePhotoUpload())return;
      if(live.disabled){
        live.disabled=false;
        live.dataset.submitRecovery='1';
      }
    },40);
  }

  document.addEventListener('click',e=>{
    if(e.target.closest('.outcome'))markRecoveryIfNeeded();
  });

  document.addEventListener('click',async e=>{
    const btn=e.target.closest('#submitVisit[data-submit-recovery="1"]');
    if(!btn)return;
    e.preventDefault();
    e.stopImmediatePropagation();

    const outcome=selectedOutcome();
    if(!outcome)return toast('Choose the final store status first.','error');
    if(activePhotoUpload())return toast('Wait for the current photo upload to finish.','error');

    const code=String(sessionStorage.getItem('smf_code')||'').trim();
    if(!code)return toast('Your field session expired. Sign in again.','error');
    if(!confirm('Submit this store as '+(outcome==='CLOSED'?'STORE CLOSED':outcome)+'?'))return;

    const oldText=btn.textContent;
    btn.disabled=true;
    btn.textContent='SUBMITTING…';
    try{
      const storeKey=await resolveStoreKey(code);
      const payload=currentPayload(storeKey);
      await apiAction('submitStoreVisitV4',[code,payload,outcome]);
      toast('Store visit submitted ✓','success');
      window.setTimeout(()=>location.reload(),650);
    }catch(err){
      btn.disabled=false;
      btn.textContent=oldText;
      toast(err?.message||'Store submission failed. Please retry.','error');
    }
  },true);

  // Re-check after store content is rendered or rerendered.
  const observer=new MutationObserver(()=>markRecoveryIfNeeded());
  observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','disabled']});
})();
