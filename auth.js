(() => {
  'use strict';
  const API=String(window.SMF_CONFIG?.API_BASE_URL||'').replace(/\/$/,'');
  const form=document.getElementById('universalLoginForm');
  const input=document.getElementById('universalCode');
  const btn=document.getElementById('universalLoginBtn');
  const err=document.getElementById('universalLoginError');
  const status=document.getElementById('universalLoginStatus');

  async function api(action,args=[]){
    if(!API)throw new Error('SMF API is not configured.');
    let r;
    try{r=await fetch(API+'/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,args}),cache:'no-store',credentials:'omit'})}
    catch(_){throw new Error('Network connection failed. Check signal and retry.');}
    let d={};try{d=await r.json()}catch(_){throw new Error('The server returned an unreadable response.');}
    if(!r.ok||d.ok===false)throw new Error(d.error||('Server error '+r.status));
    return Object.prototype.hasOwnProperty.call(d,'result')?d.result:d;
  }

  function clearRoleSessions(){
    sessionStorage.removeItem('smf_code');
    sessionStorage.removeItem('smf_admin_code');
    sessionStorage.removeItem('smf_client_code');
  }

  form.addEventListener('submit',async e=>{
    e.preventDefault();
    err.textContent='';status.textContent='Signing in…';btn.disabled=true;
    try{
      const code=input.value.trim();
      const r=await api('loginV4',[code]);
      const role=String(r?.user?.role||'').toUpperCase();
      clearRoleSessions();
      if(role==='FIELD'){
        sessionStorage.setItem('smf_code',code);
        status.textContent='Opening Field workspace…';
        location.replace('./field.html');
        return;
      }
      if(role==='ADMIN'){
        sessionStorage.setItem('smf_admin_code',code);
        status.textContent='Opening Admin workspace…';
        location.replace('./admin.html');
        return;
      }
      if(role==='CLIENT'){
        sessionStorage.setItem('smf_client_code',code);
        status.textContent='Opening Client dashboard…';
        location.replace('./client.html');
        return;
      }
      throw new Error('This access code does not have a recognized SMF role.');
    }catch(e){
      status.textContent='';
      err.textContent=e.message||String(e);
      btn.disabled=false;
    }
  });
})();
