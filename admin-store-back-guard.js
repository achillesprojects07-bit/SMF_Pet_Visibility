(() => {
  'use strict';

  // Admin store-detail navigation only. No API calls and no data writes.
  // Keeps the current Stores & POE filters/search intact when returning from a store detail.
  function addBackButton(){
    const detail=document.getElementById('adminStoreDetail');
    if(!detail||!detail.children.length||detail.querySelector('.adminBackToStoreList'))return;

    const firstCard=detail.querySelector('section.card');
    if(!firstCard||firstCard.classList.contains('loading')||firstCard.classList.contains('error'))return;

    const bar=document.createElement('div');
    bar.className='adminActions adminStoreBackBar';
    bar.style.marginBottom='12px';

    const button=document.createElement('button');
    button.type='button';
    button.className='secondary adminBackToStoreList';
    button.textContent='← Back to store list';
    button.setAttribute('aria-label','Back to current filtered store list');

    button.addEventListener('click',()=>{
      detail.innerHTML='';
      const target=document.getElementById('storeTableWrap')||document.getElementById('storeStatus');
      target?.scrollIntoView({behavior:'smooth',block:'start'});
    });

    bar.appendChild(button);
    detail.insertBefore(bar,detail.firstChild);
  }

  const observer=new MutationObserver(addBackButton);
  observer.observe(document.documentElement,{childList:true,subtree:true});
  addBackButton();
})();
