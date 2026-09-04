(() => {
  'use strict';

  function photoWorkInProgress(){
    if(document.querySelector('.photoSlot.uploading'))return true;
    return [...document.querySelectorAll('.photoStatus')].some(el=>/saved\s*[—-]\s*sync/i.test(String(el.textContent||'')));
  }

  function showUploadWarning(){
    const toast=document.getElementById('toast');
    if(toast){
      toast.textContent='A photo is still uploading or syncing. Keep this store open until you see ✓ Uploaded.';
      toast.dataset.type='error';
      toast.classList.remove('hidden');
      clearTimeout(window.__smfStabilityToast);
      window.__smfStabilityToast=setTimeout(()=>toast.classList.add('hidden'),4200);
    }
  }

  // Prevent leaving the store while either photo bytes or the final POE record are still in flight.
  document.addEventListener('click',e=>{
    if(!photoWorkInProgress())return;
    const target=e.target.closest('#backBtn,#logoutBtn,.fieldBrand');
    if(!target)return;
    e.preventDefault();
    e.stopImmediatePropagation();
    showUploadWarning();
  },true);

  // Browsers that support beforeunload will warn before a refresh/tab close while photo work is active.
  window.addEventListener('beforeunload',e=>{
    if(!photoWorkInProgress())return;
    e.preventDefault();
    e.returnValue='';
  });
})();
