(() => {
  'use strict';

  // Admin overview navigation only. No API calls and no data writes.
  // Makes each overview status tile open Stores & POE with the matching status filter.
  const STATUS_BY_CLASS={
    total:'',
    completed:'COMPLETED',
    incomplete:'INCOMPLETE',
    refused:'REFUSED',
    closed:'CLOSED',
    open:'NOT STARTED'
  };

  function targetStatus(metric){
    for(const [cls,status] of Object.entries(STATUS_BY_CLASS))if(metric.classList.contains(cls))return status;
    return null;
  }

  function applyWhenReady(status,attempt=0){
    const select=document.getElementById('storeStatus');
    if(select){
      select.value=status;
      select.dispatchEvent(new Event('input',{bubbles:true}));
      select.dispatchEvent(new Event('change',{bubbles:true}));
      select.scrollIntoView({behavior:'smooth',block:'center'});
      return;
    }
    if(attempt<40)setTimeout(()=>applyWhenReady(status,attempt+1),50);
  }

  document.addEventListener('click',e=>{
    const metric=e.target.closest('#tab_overview .metric');
    if(!metric)return;
    const status=targetStatus(metric);
    if(status===null)return;
    e.preventDefault();
    const storesTab=document.querySelector('.adminTab[data-tab="stores"]');
    if(!storesTab)return;
    storesTab.click();
    applyWhenReady(status);
  });

  // Keyboard accessibility for the same dashboard navigation.
  document.addEventListener('keydown',e=>{
    if(e.key!=='Enter'&&e.key!==' ')return;
    const metric=e.target.closest?.('#tab_overview .metric');
    if(!metric)return;
    e.preventDefault();
    metric.click();
  });

  const observer=new MutationObserver(()=>{
    document.querySelectorAll('#tab_overview .metric').forEach(metric=>{
      if(targetStatus(metric)===null)return;
      metric.tabIndex=0;
      metric.setAttribute('role','button');
      metric.style.cursor='pointer';
      const name=metric.querySelector('span')?.textContent?.trim()||'stores';
      metric.setAttribute('aria-label','Show '+name+' stores');
    });
  });
  observer.observe(document.documentElement,{childList:true,subtree:true});
})();
