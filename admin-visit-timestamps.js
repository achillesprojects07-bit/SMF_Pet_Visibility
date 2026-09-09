(() => {
  'use strict';

  // Display-only refinement for Admin store visit timestamps.
  // No API calls, no data writes, no store-content replacement.

  function refine(){
    const detail=document.getElementById('adminStoreDetail');
    if(!detail)return;
    const lines=[...detail.querySelectorAll('.storeDetail>div:first-child .systemLine')];
    const finalized=lines.find(line=>line.querySelector('span')?.textContent?.trim()==='Finalized at');
    const updated=lines.find(line=>line.querySelector('span')?.textContent?.trim()==='Updated');
    if(!finalized)return;

    const finalizedLabel=finalized.querySelector('span');
    const finalizedValue=finalized.querySelector('b')?.textContent?.trim()||'';
    if(finalizedLabel)finalizedLabel.textContent='Finalized';

    if(updated){
      const updatedLabel=updated.querySelector('span');
      const updatedValue=updated.querySelector('b')?.textContent?.trim()||'';
      if(!updatedValue||updatedValue==='—'||updatedValue===finalizedValue){
        updated.hidden=true;
      }else{
        updated.hidden=false;
        if(updatedLabel)updatedLabel.textContent='Last updated';
      }
    }
  }

  const stores=document.getElementById('tab_stores');
  if(stores){
    new MutationObserver(refine).observe(stores,{childList:true,subtree:true});
  }
})();
