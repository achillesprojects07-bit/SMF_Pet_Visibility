(() => {
  'use strict';

  // Admin store-detail UX only. No API calls and no data writes.
  // The existing admin.js remains responsible for fetching/opening the store.
  // This guard provides immediate feedback, focuses the detail view, and preserves
  // the current search/filter state when returning to the store list.

  let openingButton=null;
  let openingTimer=null;

  function detail(){return document.getElementById('adminStoreDetail')}
  function list(){return document.getElementById('storeTableWrap')}

  function storeNameFromTarget(target){
    const row=target.closest?.('.adminStoreRow');
    return row?.querySelector('td b')?.textContent?.trim()||'store';
  }

  function beginOpening(target){
    const d=detail(),l=list();
    if(!d||!l)return;

    const button=target.closest?.('.adminOpenStore');
    openingButton=button||null;
    if(openingButton){
      openingButton.dataset.originalText=openingButton.textContent||'OPEN';
      openingButton.textContent='Opening…';
      openingButton.setAttribute('aria-busy','true');
      openingButton.classList.add('adminOpeningButton');
    }

    const name=storeNameFromTarget(target);
    d.innerHTML=`<section class="card loading adminOpeningCard" role="status" aria-live="polite"><div class="adminOpeningSpinner" aria-hidden="true"></div><div><b>Opening ${escapeHtml(name)}…</b><div class="small">Loading store details and POE.</div></div></section>`;
    l.classList.add('adminStoreListOpening');
    d.scrollIntoView({behavior:'smooth',block:'start'});

    clearTimeout(openingTimer);
    openingTimer=setTimeout(()=>{
      const card=d.querySelector('.adminOpeningCard');
      if(card){
        card.innerHTML='<div><b>This store is taking longer than expected to open.</b><div class="small">Please wait a moment or use Back to store list and try again.</div></div>';
        addBackButton();
      }
    },10000);
  }

  function escapeHtml(v){
    return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function finishOpeningButton(){
    if(!openingButton)return;
    openingButton.textContent=openingButton.dataset.originalText||'OPEN';
    openingButton.removeAttribute('aria-busy');
    openingButton.classList.remove('adminOpeningButton');
    delete openingButton.dataset.originalText;
    openingButton=null;
  }

  function restoreList(){
    clearTimeout(openingTimer);
    finishOpeningButton();
    const d=detail(),l=list();
    if(d)d.innerHTML='';
    if(l){
      l.classList.remove('adminStoreListOpening','adminStoreListHidden');
      l.scrollIntoView({behavior:'smooth',block:'start'});
    }else{
      document.getElementById('storeStatus')?.scrollIntoView({behavior:'smooth',block:'center'});
    }
  }

  function addBackButton(){
    const d=detail(),l=list();
    if(!d||!d.children.length)return;

    const firstCard=d.querySelector('section.card');
    if(!firstCard)return;

    // Keep the store list out of the way while a store is opening or displayed.
    if(l)l.classList.add('adminStoreListHidden');

    // Wait for the real detail or the long-wait message before adding navigation.
    if(firstCard.classList.contains('loading')&&!firstCard.classList.contains('adminOpeningCard'))return;
    if(d.querySelector('.adminBackToStoreList'))return;

    clearTimeout(openingTimer);
    finishOpeningButton();

    const bar=document.createElement('div');
    bar.className='adminActions adminStoreBackBar';

    const button=document.createElement('button');
    button.type='button';
    button.className='secondary adminBackToStoreList';
    button.textContent='← Back to store list';
    button.setAttribute('aria-label','Back to current filtered store list');
    button.addEventListener('click',restoreList);

    bar.appendChild(button);
    d.insertBefore(bar,d.firstChild);
  }

  // Capture the user's intent first, then allow admin.js's existing delegated click
  // handler to perform the actual read-only store-detail request.
  document.addEventListener('click',e=>{
    const target=e.target.closest?.('#storeTableWrap .adminOpenStore, #storeTableWrap .adminStoreRow');
    if(!target)return;
    beginOpening(target);
  },true);

  const observer=new MutationObserver(()=>{
    const d=detail();
    if(!d||!d.children.length)return;
    const realCard=d.querySelector('section.card:not(.adminOpeningCard)');
    if(realCard){
      list()?.classList.add('adminStoreListHidden');
      realCard.scrollIntoView({behavior:'smooth',block:'start'});
      addBackButton();
    }
  });
  observer.observe(document.documentElement,{childList:true,subtree:true});
})();
