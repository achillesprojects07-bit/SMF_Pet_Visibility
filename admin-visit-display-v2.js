(() => {
  'use strict';

  function apply(){
    const detail=document.getElementById('adminStoreDetail');
    if(!detail)return;
    const visit=detail.querySelector('.storeDetail>div:first-child');
    if(!visit)return;

    const lines=[...visit.querySelectorAll('.systemLine')];
    for(const line of lines){
      const label=line.querySelector('span');
      if(!label)continue;
      const text=label.textContent.trim();
      if(text==='Finalized by')label.textContent='Submitted by';
      else if(text==='Finalized at'||text==='Finalized')label.textContent='Submitted on';
      else if(text==='Updated'||text==='Last updated')line.remove();
    }
  }

  const run=()=>{apply();requestAnimationFrame(apply);setTimeout(apply,50);setTimeout(apply,250)};
  document.addEventListener('click',e=>{
    if(e.target.closest('.adminOpenStore,.adminStoreRow,.issueOpen'))run();
  },true);

  const stores=document.getElementById('tab_stores');
  if(stores)new MutationObserver(run).observe(stores,{childList:true,subtree:true});
  run();
})();
