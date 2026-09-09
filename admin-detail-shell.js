(() => {
  'use strict';

  // Passive Admin store-detail page controller only.
  // Does not fetch data, mutate store content, observe renders, or write any data.
  // admin.js remains the sole owner of the store-detail DOM and API lifecycle.

  let savedScrollY=0;
  let backButton=null;

  function detail(){return document.getElementById('adminStoreDetail')}
  function storeSection(){return detail()?.closest('section.card')||null}

  function ensureBackButton(){
    const section=storeSection();
    if(!section)return null;
    if(backButton&&section.contains(backButton))return backButton;
    backButton=document.createElement('button');
    backButton.type='button';
    backButton.className='secondary adminInlineBack';
    backButton.textContent='← Back to store list';
    backButton.setAttribute('aria-label','Back to current filtered store list');
    backButton.addEventListener('click',closeDetail);
    section.insertBefore(backButton,detail());
    return backButton;
  }

  function openDetailSection(){
    const d=detail(),section=storeSection();
    if(!d||!section)return;
    savedScrollY=window.scrollY;
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
    requestAnimationFrame(()=>window.scrollTo({top:savedScrollY,behavior:'auto'}));
  }

  document.addEventListener('click',e=>{
    const target=e.target.closest?.('#storeTableWrap .adminOpenStore, #storeTableWrap .adminStoreRow');
    if(!target)return;
    openDetailSection();
  },true);

  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&storeSection()?.classList.contains('adminStoreDetailMode'))closeDetail();
  });
})();
