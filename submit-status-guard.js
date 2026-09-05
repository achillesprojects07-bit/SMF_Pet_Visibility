(() => {
  'use strict';

  // Display/refresh guard only. It does not submit, edit, delete, move, or write POE data.
  // It makes a successful submitted outcome visible immediately and refreshes the schedule
  // when the user returns, so the store card does not remain stale as OPEN.

  const KEY='smf_recent_submitted_status_v1';
  let pending=null;
  let needsHomeRefresh=false;
  let paintQueued=false;

  function norm(v){return String(v||'').trim().toUpperCase()}
  function validOutcome(v){v=norm(v);return ['COMPLETED','INCOMPLETE','REFUSED','CLOSED'].includes(v)?v:''}
  function label(v){return v==='CLOSED'?'STORE CLOSED':v}
  function cls(v){return v==='COMPLETED'?'completed':v==='INCOMPLETE'?'incomplete':v==='REFUSED'?'refused':v==='CLOSED'?'closed':'open'}
  function fingerprint(){
    const hero=document.querySelector('#storeView .storeHero');
    if(!hero)return '';
    const name=hero.querySelector('h1')?.textContent?.trim()||'';
    const meta=hero.querySelector('.small')?.textContent?.trim()||'';
    const storeId=(meta.split('•')[0]||'').trim();
    return storeId+'|'+name;
  }
  function readConfirmed(){
    try{
      const r=JSON.parse(sessionStorage.getItem(KEY)||'null');
      if(!r||!r.fingerprint||!validOutcome(r.outcome)||Date.now()-Number(r.savedAt||0)>10*60*1000)return null;
      return r;
    }catch(_){return null}
  }
  function saveConfirmed(rec){try{sessionStorage.setItem(KEY,JSON.stringify(rec))}catch(_){}}

  function paintSubmitted(){
    const rec=readConfirmed();
    if(!rec||fingerprint()!==rec.fingerprint)return;
    const outcome=validOutcome(rec.outcome);if(!outcome)return;

    const heroBadge=document.querySelector('#storeView .storeHero .badge');
    if(heroBadge){
      heroBadge.textContent=label(outcome);
      heroBadge.classList.remove('open','completed','incomplete','refused','closed');
      heroBadge.classList.add(cls(outcome));
    }

    const sections=[...document.querySelectorAll('#storeBody section.card')];
    const finalSection=sections.find(s=>s.querySelector('h2')?.textContent?.trim()==='Final Visit Outcome');
    if(finalSection&&!finalSection.querySelector('.finalOutcome')){
      finalSection.innerHTML='<h2>Final Visit Outcome</h2><div class="finalOutcome '+cls(outcome)+'">'+label(outcome)+'</div><div class="small">✓ Store visit submitted successfully</div>';
    }
  }
  function queuePaint(){if(paintQueued)return;paintQueued=true;requestAnimationFrame(()=>{paintQueued=false;paintSubmitted()})}

  document.addEventListener('click',e=>{
    const submit=e.target?.closest?.('#submitVisit');
    if(submit){
      const selected=document.querySelector('#storeView .outcome.selected');
      const outcome=validOutcome(selected?.dataset?.outcome);
      const fp=fingerprint();
      if(outcome&&fp)pending={fingerprint:fp,outcome};
      return;
    }

    if(e.target?.closest?.('#backBtn')&&needsHomeRefresh){
      setTimeout(()=>{
        const refresh=document.getElementById('refreshBtn');
        if(refresh){needsHomeRefresh=false;refresh.click()}
      },50);
    }
  },true);

  const observer=new MutationObserver(()=>{
    const toast=document.getElementById('toast');
    if(pending&&toast&&!toast.classList.contains('hidden')&&/Store visit submitted/i.test(toast.textContent||'')){
      const rec={...pending,savedAt:Date.now()};
      saveConfirmed(rec);pending=null;needsHomeRefresh=true;queuePaint();
    }else if(readConfirmed())queuePaint();
  });

  observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class']});
})();