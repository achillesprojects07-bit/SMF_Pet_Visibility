(() => {
  'use strict';

  // Reliability guard for Issues -> Inspect Store.
  // It does not call APIs or write data. It waits for the Stores view to render,
  // then reuses the existing Stores-table OPEN behavior so admin.js remains the
  // sole owner of loading/rendering store details.

  function openFromIssues(button){
    const key=button?.dataset?.key;
    if(!key)return;

    // Tell the passive detail shell that Back should return to Issues even though
    // we temporarily navigate through the Stores tab to reuse its proven loader.
    window.__smfAdminReturnTabHint='issues';

    const storesTab=document.querySelector('.adminTab[data-tab="stores"]');
    if(!storesTab)return;
    storesTab.click();

    let attempt=0;
    const tryOpen=()=>{
      const selector=`#storeTableWrap .adminOpenStore[data-key="${CSS.escape(key)}"]`;
      const openButton=document.querySelector(selector);
      if(openButton){
        openButton.click();
        setTimeout(()=>{delete window.__smfAdminReturnTabHint},0);
        return;
      }
      if(attempt++<80){
        setTimeout(tryOpen,50);
      }else{
        delete window.__smfAdminReturnTabHint;
        const issuesTab=document.querySelector('.adminTab[data-tab="issues"]');
        issuesTab?.click();
      }
    };
    tryOpen();
  }

  // Capture the click before admin.js' older programmatic open path can race the
  // asynchronous Stores render.
  document.addEventListener('click',e=>{
    const button=e.target.closest?.('.issueOpen');
    if(!button)return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openFromIssues(button);
  },true);
})();
