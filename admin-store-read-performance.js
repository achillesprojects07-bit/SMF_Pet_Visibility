(() => {
  'use strict';

  // Admin READ/PERCEIVED-PERFORMANCE layer only.
  // No API calls. No writes. No store/POE/photo mutations.
  // admin.js remains the sole owner of the authoritative getAdminStoreV4 request.

  const cache=new Map();
  let opening=null;

  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function detail(){return document.getElementById('adminStoreDetail')}

  function rowSnapshot(target){
    const row=target.closest?.('.adminStoreRow');
    if(!row)return null;
    const cells=[...row.querySelectorAll(':scope > td')];
    const name=cells[0]?.querySelector('b')?.textContent?.trim()||'Store';
    const sub=cells[0]?.querySelector('.small')?.textContent?.trim()||'';
    const status=cells[4]?.querySelector('b')?.textContent?.trim()||'';
    return {
      key:String(row.dataset.key||''),
      name,
      sub,
      team:cells[1]?.textContent?.trim()||'',
      day:cells[2]?.textContent?.trim()||'',
      area:cells[3]?.textContent?.trim()||'',
      status,
      completedAt:cells[5]?.textContent?.trim()||''
    };
  }

  function previewHtml(s,refreshing=false){
    return `<section class="card adminInstantStorePreview" role="status" aria-live="polite">
      <div class="sectionTitle">
        <div><h2>${esc(s.name)}</h2><div class="small">${esc([s.team,s.day,s.area].filter(Boolean).join(' • '))}</div></div>
        ${s.status?`<span class="badge">${esc(s.status)}</span>`:''}
      </div>
      ${s.sub?`<div class="small" style="margin-top:6px">${esc(s.sub)}</div>`:''}
      <div class="adminReadProgress" style="margin-top:14px"><span class="adminOpeningSpinner" aria-hidden="true"></span><div><b>${refreshing?'Refreshing latest store data…':'Loading latest store data…'}</b><div class="small">Store identity is ready. POE, notes, inventory and photos are loading in the background.</div></div></div>
    </section>`;
  }

  function showInstant(snapshot){
    const d=detail();
    if(!d||!snapshot)return;
    const cached=cache.get(snapshot.key);
    if(cached&&Date.now()-cached.savedAt<60000){
      d.innerHTML=`<div class="adminCachedStoreDetail">${cached.html}</div><div class="card adminRefreshStrip"><span class="adminOpeningSpinner" aria-hidden="true"></span><b>Refreshing latest store data…</b></div>`;
    }else{
      d.innerHTML=previewHtml(snapshot,false);
    }
    d.classList.add('adminStoreOverlayActive');
    document.body.classList.add('adminStoreDetailOpen');
    window.scrollTo({top:0,behavior:'auto'});
  }

  document.addEventListener('click',e=>{
    const target=e.target.closest?.('#storeTableWrap .adminOpenStore, #storeTableWrap .adminStoreRow');
    if(!target)return;
    const snapshot=rowSnapshot(target);
    if(!snapshot||!snapshot.key)return;
    opening={key:snapshot.key,snapshot,started:performance.now()};
    // Run after admin.js has replaced the area with its generic Loading state.
    setTimeout(()=>showInstant(snapshot),0);
  },true);

  const observer=new MutationObserver(()=>{
    const d=detail();
    if(!d||!opening)return;

    const real=d.querySelector('section.card:not(.loading):not(.adminInstantStorePreview):not(.adminOpeningCard)');
    if(!real)return;

    // The authoritative admin.js response has arrived. Cache only the rendered READ view.
    const elapsed=Math.max(0,performance.now()-opening.started);
    real.dataset.adminReadMs=String(Math.round(elapsed));
    real.querySelectorAll('img').forEach(img=>{
      img.loading='lazy';
      img.decoding='async';
      img.fetchPriority='low';
    });

    // Cache the authoritative rendered detail for instant same-session reopen.
    cache.set(opening.key,{html:real.outerHTML,savedAt:Date.now(),readMs:Math.round(elapsed)});
    console.info(`[SMF Admin] getAdminStoreV4 rendered in ${Math.round(elapsed)} ms for ${opening.key}`);
    opening=null;
  });
  observer.observe(document.documentElement,{childList:true,subtree:true});
})();
