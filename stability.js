(() => {
  'use strict';

  function uploadInProgress(){
    return !!document.querySelector('.photoSlot.uploading');
  }

  function showUploadWarning(){
    const toast=document.getElementById('toast');
    if(toast){
      toast.textContent='A photo is still uploading. Keep this store open until you see ✓ Uploaded.';
      toast.dataset.type='error';
      toast.classList.remove('hidden');
      clearTimeout(window.__smfStabilityToast);
      window.__smfStabilityToast=setTimeout(()=>toast.classList.add('hidden'),4200);
    }
  }

  // Capture navigation before the app's normal click handlers can change state.current.
  // This keeps upload retries pinned to the store where the upload began.
  document.addEventListener('click',e=>{
    if(!uploadInProgress())return;
    const target=e.target.closest('#backBtn,#logoutBtn,.fieldBrand');
    if(!target)return;
    e.preventDefault();
    e.stopImmediatePropagation();
    showUploadWarning();
  },true);

  // Browsers that support beforeunload will warn before a refresh/tab close while an upload is active.
  window.addEventListener('beforeunload',e=>{
    if(!uploadInProgress())return;
    e.preventDefault();
    e.returnValue='';
  });
})();
