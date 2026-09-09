(() => {
  'use strict';

  // Passive Admin store-detail page controller only.
  // Does not fetch data, replace store content, or write any data.
  // admin.js remains the sole owner of the store-detail DOM and API lifecycle.

  let savedScrollY=0;
  let backButton=null;
  let isOpen=false;
  let returnTab='stores';

  function detail(){return document.getElementById('adminStoreDetail')}
  function storeSection(){return detail()?.closest('section.card')||null}

  function backCopy(){
    return returnTab==='issues'?'← Back to issues':'← Back to store list';
  }

  function ensureBackButton(){
    const section=storeSection();
    if(!section)return null;
    if(!backButton||!section.contains(backButton)){
      backButton=document.createElement('button');
      backButton.type='button';
      backButton.className='secondary adminInlineBack';
      backButton.addEventListener('click',closeDetail);
      section.insertBefore(backButton,detail());
    }
    backButton.textContent=backCopy();
    backButton.setAttribute('aria-label',returnTab==='issues'?'Back to Issues':'Back to current filtered store list');
    return backButton;
  }

  function openDetailSection(){
    const d=detail(),section=storeSection();
    if(!d||!section)return;
    if(!isOpen)savedScrollY=window.scrollY;
    isOpen=true;
    document.body.classList.add('adminStorePageMode');
    document.getElementById('adminApp')?.classList.add('adminStorePageMode');
    section.classList.add('adminStoreDetailMode');
    d.classList.add('adminStoreDetailInline');
    ensureBackButton()?.classList.add('isVisible');
    requestAnimationFrame(()=>window.scrollTo({top:0,behavior:'auto'}));
  }

  function closeDetail(){
    const d=detail(),section=storeSection();
    if(d){
      d.classList.remove('adminStoreDetailInline');
      d.innerHTML='';
    }
    section?.classList.remove('adminStoreDetailMode');
    document.body.classList.remove('adminStorePageMode');
    document.getElementById('adminApp')?.classList.remove('adminStorePageMode');
    if(backButton)backButton.classList.remove('isVisible');
    isOpen=false;

    const destination=returnTab;
    returnTab='stores';
    if(destination==='issues'){
      const issuesTab=document.querySelector('.adminTab[data-tab="issues"]');
      if(issuesTab){
        issuesTab.click();
        requestAnimationFrame(()=>window.scrollTo({top:savedScrollY,behavior:'auto'}));
        return;
      }
    }
    requestAnimationFrame(()=>window.scrollTo({top:savedScrollY,behavior:'auto'}));
  }

  // Remember where the Admin came from before admin.js changes tabs.
  // Capture phase runs before the existing issue/store click handlers.
  document.addEventListener('click',e=>{
    if(e.target.closest?.('.issueOpen')){
      returnTab='issues';
      return;
    }
    const target=e.target.closest?.('#storeTableWrap .adminOpenStore, #storeTableWrap .adminStoreRow');
    if(!target)return;
    returnTab='stores';
    openDetailSection();
  },true);

  // Programmatic opens also occur after "Inspect Store" from Issues and after
  // an Admin reopens a visit for correction. Observe only whether detail content
  // appears; never alter or replace the content produced by admin.js.
  const stores=document.getElementById('tab_stores');
  if(stores){
    new MutationObserver(()=>{
      const d=detail();
      if(!d)return;
      if(d.childElementCount>0)openDetailSection();
    }).observe(stores,{childList:true,subtree:true});
  }

  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&isOpen)closeDetail();
  });
})();
