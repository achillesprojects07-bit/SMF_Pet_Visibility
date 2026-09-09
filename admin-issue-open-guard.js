(() => {
  'use strict';

  // Reliable Issues -> Inspect Store navigation.
  // Frontend-only: no API calls, no writes, no store-content replacement.
  // Reuses the already-proven Stores table OPEN action after that view is ready.

  let opening=false;

  function exactOpenButton(key){
    return [...document.querySelectorAll('#storeTableWrap .adminOpenStore')]
      .find(button=>String(button.dataset.key||'')===String(key||''))||null;
  }

  function showIssueButtonState(button,busy){
    if(!button)return;
    if(busy){
      if(!button.dataset.originalText)button.dataset.originalText=button.textContent;
      button.textContent='Opening…';
      button.disabled=true;
    }else{
      button.textContent=button.dataset.originalText||'Inspect Store';
      button.disabled=false;
    }
  }

  function returnToIssues(button,message){
    opening=false;
    delete window.__smfAdminReturnTabHint;
    document.querySelector('.adminTab[data-tab="issues"]')?.click();
    setTimeout(()=>{
      const replacement=[...document.querySelectorAll('.issueOpen')]
        .find(x=>String(x.dataset.key||'')===String(button?.dataset?.key||''));
      showIssueButtonState(replacement||button,false);
      if(message){
        const toast=document.getElementById('adminToast');
        if(toast){
          toast.textContent=message;
          toast.dataset.type='error';
          toast.classList.remove('hidden');
          setTimeout(()=>toast.classList.add('hidden'),4000);
        }
      }
    },0);
  }

  function openFromIssues(button){
    if(opening)return;
    const key=String(button?.dataset?.key||'');
    if(!key)return;
    opening=true;
    showIssueButtonState(button,true);
    window.__smfAdminReturnTabHint='issues';

    const storesTab=document.querySelector('.adminTab[data-tab="stores"]');
    if(!storesTab){
      returnToIssues(button,'Stores view is unavailable. Please refresh and try again.');
      return;
    }

    storesTab.click();

    let attempt=0;
    const tryOpen=()=>{
      const openButton=exactOpenButton(key);
      if(openButton){
        // Keep the return hint through the synthetic click; the detail shell reads it.
        openButton.click();
        opening=false;
        setTimeout(()=>{delete window.__smfAdminReturnTabHint},250);
        return;
      }
      if(attempt++<120){
        setTimeout(tryOpen,50);
        return;
      }
      returnToIssues(button,'Could not open this store. Please refresh and try again.');
    };
    tryOpen();
  }

  // Capture before admin.js' older Issues handler, which can race the async Stores render.
  document.addEventListener('click',e=>{
    const button=e.target.closest?.('.issueOpen');
    if(!button)return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openFromIssues(button);
  },true);
})();
