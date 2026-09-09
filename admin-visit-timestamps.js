(() => {
  'use strict';

  // Display-only refinement for Admin store visit timestamps.
  // No API calls, no data writes, no store-content replacement.
  // The technical updatedAt value remains preserved in backend data but is not shown here.

  function refine(){
    const detail=document.getElementById('adminStoreDetail');
    if(!detail)return;
    const lines=[...detail.querySelectorAll('.storeDetail>div:first-child .systemLine')];

    const submittedBy=lines.find(line=>line.querySelector('span')?.textContent?.trim()==='Finalized by');
    const submittedOn=lines.find(line=>['Finalized at','Finalized','Submitted on'].includes(line.querySelector('span')?.textContent?.trim()));
    const updated=lines.find(line=>['Updated','Last updated'].includes(line.querySelector('span')?.textContent?.trim()));

    if(submittedBy?.querySelector('span'))submittedBy.querySelector('span').textContent='Submitted by';
    if(submittedOn?.querySelector('span'))submittedOn.querySelector('span').textContent='Submitted on';
    if(updated)updated.hidden=true;
  }

  const stores=document.getElementById('tab_stores');
  if(stores){
    new MutationObserver(refine).observe(stores,{childList:true,subtree:true});
  }
})();
