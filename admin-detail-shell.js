(() => {
  'use strict';

  // Passive Admin store-detail shell only.
  // Does not fetch data, mutate store content, observe renders, or write any data.
  // admin.js remains the sole owner of the store-detail DOM and API lifecycle.

  let savedScrollY=0;
  let backButton=null;
  let backdrop=null;

  function detail(){return document.getElementById('adminStoreDetail')}

  function ensureBackdrop(){
    if(backdrop&&document.body.contains(backdrop))return backdrop;
    backdrop=document.createElement('div');
    backdrop.className='adminDetailBackdrop';
    backdrop.setAttribute('aria-hidden','true');
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function ensureBackButton(){
    if(backButton&&document.body.contains(backButton))return backButton;
    backButton=document.createElement('button');
    backButton.type='button';
    backButton.className='secondary adminFloatingBack';
    backButton.textContent='← Back to store list';
    backButton.setAttribute('aria-label','Back to current filtered store list');
    backButton.addEventListener('click',closeDetail);
    document.body.appendChild(backButton);
    return backButton;
  }

  function openDetailShell(){
    const d=detail();
    if(!d)return;
    savedScrollY=window.scrollY;
    ensureBackdrop().classList.add('isVisible');
    d.classList.add('adminStoreDetailFocused');
    d.scrollTop=0;
    document.documentElement.classList.add('adminDetailOpen');
    document.body.classList.add('adminDetailOpen');
    ensureBackButton().classList.add('isVisible');
  }

  function closeDetail(){
    const d=detail();
    if(d){
      d.classList.remove('adminStoreDetailFocused');
      d.innerHTML='';
    }
    document.documentElement.classList.remove('adminDetailOpen');
    document.body.classList.remove('adminDetailOpen');
    if(backdrop)backdrop.classList.remove('isVisible');
    if(backButton)backButton.classList.remove('isVisible');
    requestAnimationFrame(()=>window.scrollTo({top:savedScrollY,behavior:'auto'}));
  }

  document.addEventListener('click',e=>{
    const target=e.target.closest?.('#storeTableWrap .adminOpenStore, #storeTableWrap .adminStoreRow');
    if(!target)return;
    openDetailShell();
  },true);

  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&detail()?.classList.contains('adminStoreDetailFocused'))closeDetail();
  });
})();
