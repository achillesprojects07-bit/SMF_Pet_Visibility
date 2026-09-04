(() => {
  'use strict';

  function applyDayFilter(){
    const dayJump=document.getElementById('dayJump');
    const storeJump=document.getElementById('storeJump');
    if(!dayJump)return;

    const selected=dayJump.value;
    document.querySelectorAll('[data-day-section]').forEach(section=>{
      section.classList.toggle('hidden',section.dataset.daySection!==selected);
    });

    if(storeJump){
      const visible=document.querySelector(`[data-day-section="${CSS.escape(selected)}"]`);
      const stores=visible?[...visible.querySelectorAll('.storeRow')]:[];
      const current=storeJump.value;
      storeJump.innerHTML='<option value="">Choose a store…</option>'+stores.map(btn=>{
        const key=btn.dataset.key||'';
        const text=(btn.querySelector('.storeText b')?.textContent||'Store').trim();
        const stop=(btn.querySelector('.storeText span')?.textContent||'').match(/Stop\s+([^•]+)/i)?.[1]?.trim();
        const label=(stop?`Stop ${stop} — `:'')+text;
        return `<option value="${key.replace(/"/g,'&quot;')}">${label.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</option>`;
      }).join('');
      if([...storeJump.options].some(o=>o.value===current))storeJump.value=current;
    }
  }

  document.addEventListener('change',e=>{
    if(e.target?.id!=='dayJump')return;
    e.stopImmediatePropagation();
    applyDayFilter();
    document.getElementById('days')?.scrollIntoView({behavior:'smooth',block:'start'});
  },true);

  const days=document.getElementById('days');
  if(days){
    new MutationObserver(()=>requestAnimationFrame(applyDayFilter)).observe(days,{childList:true,subtree:true});
  }
  requestAnimationFrame(applyDayFilter);
})();
