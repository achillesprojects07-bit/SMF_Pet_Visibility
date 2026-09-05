(() => {
  'use strict';

  // Read-only compatibility + visibility guard for additional POE photos.
  // It never uploads, deletes, renames, moves, or edits Drive/Sheets data.
  // It keeps EXTRA__ rows separate from the required main photo and shows
  // field users exactly how many photos exist for each shot-list item.

  const nativeFetch = window.fetch.bind(window);
  const EXTRA_PREFIX = 'EXTRA__';
  const shotCounts = new Map();
  const completedUploads = new Set();

  function norm(v){ return String(v || '').toUpperCase(); }
  function exactMain(group, baseType) {
    if (!Array.isArray(group)) return null;
    const base = norm(baseType);
    return group.find(p => norm(p?.type) === base) || null;
  }
  function extrasFor(group, baseType){
    const base = norm(baseType);
    return (Array.isArray(group) ? group : []).filter(p => {
      const t = norm(p?.type);
      return t.startsWith(EXTRA_PREFIX + base + '__');
    });
  }

  function setCount(baseType, mainCount, extraCount){
    const base = norm(baseType);
    if(!base) return;
    shotCounts.set(base,{main:Number(mainCount||0),extras:Number(extraCount||0)});
    paintCount(base);
  }

  function paintCount(baseType){
    const base = norm(baseType), c = shotCounts.get(base);
    if(!c) return;
    const slot = document.getElementById('slot_' + base);
    if(!slot) return;
    let el = slot.querySelector('[data-photo-count]');
    if(!el){
      el = document.createElement('div');
      el.setAttribute('data-photo-count','');
      el.style.fontWeight='700';
      el.style.marginTop='6px';
      el.style.marginBottom='6px';
      const title = slot.querySelector('.photoTitle');
      if(title && title.nextSibling) slot.insertBefore(el,title.nextSibling); else slot.appendChild(el);
    }
    const total = c.main + c.extras;
    el.textContent = total + ' photo' + (total===1?'':'s') + ' uploaded' + (total ? ' — ' + c.main + ' main' + (c.extras ? ' + ' + c.extras + ' additional' : '') : '');
    el.dataset.total=String(total);
  }

  function paintAll(){ shotCounts.forEach((_,base)=>paintCount(base)); }

  function normalizeStoreResult(result) {
    if (!result || typeof result !== 'object') return result;
    const groups = result.photoGroups && typeof result.photoGroups === 'object' ? result.photoGroups : {};
    const photos = result.photos && typeof result.photos === 'object' ? { ...result.photos } : {};
    const required = Array.isArray(result.requiredPhotos) ? result.requiredPhotos : [];

    required.forEach(req => {
      const base = norm(req?.type);
      if (!base) return;
      const group = Array.isArray(groups[base]) ? groups[base] : [];
      const main = exactMain(group, base);
      if (main) photos[base] = main;
      else if (norm(photos[base]?.type).startsWith(EXTRA_PREFIX)) delete photos[base];

      const exact = main || (norm(photos[base]?.type)===base ? photos[base] : null);
      setCount(base, exact ? 1 : 0, extrasFor(group,base).length);
    });

    result.photos = photos;
    setTimeout(paintAll,0);
    return result;
  }

  function markCompletedExtra(data){
    if(!data || typeof data!=='object') return;
    const type = norm(data.type || data.photoType);
    if(!type.startsWith(EXTRA_PREFIX)) return;
    const uploadId = String(data.uploadId || data.upload_id || data.fileId || data.file_id || type);
    if(completedUploads.has(uploadId)) return;
    const status = norm(data.status);
    if(status && status!=='COMPLETE') return;
    completedUploads.add(uploadId);
    const parts = type.split('__');
    const base = parts[1] || '';
    if(!base) return;
    const c = shotCounts.get(base) || {main:1,extras:0};
    setCount(base,c.main,c.extras+1);
  }

  window.fetch = async function guardedFetch(input, init) {
    const requestUrl = typeof input === 'string' ? input : (input?.url || '');
    const method = String(init?.method || (typeof input !== 'string' ? input?.method : '') || 'GET').toUpperCase();
    let isGetStore = false;

    if (method === 'POST' && /\/api\/action(?:$|\?)/.test(requestUrl)) {
      try {
        const raw = typeof init?.body === 'string' ? init.body : '';
        const body = raw ? JSON.parse(raw) : null;
        isGetStore = body?.action === 'getStoreV4';
      } catch (_) {}
    }

    const response = await nativeFetch(input, init);

    if (isGetStore) {
      try {
        const data = await response.clone().json();
        if (data && data.ok !== false && data.result) normalizeStoreResult(data.result);
        return new Response(JSON.stringify(data), {status:response.status,statusText:response.statusText,headers:response.headers});
      } catch (_) { return response; }
    }

    // Observe only successful V6 responses to update the on-screen count immediately.
    // No request body or upload behavior is changed.
    if (/\/v6\/photo\//.test(requestUrl)) {
      try { const data = await response.clone().json(); if(response.ok && data?.ok!==false) markCompletedExtra(data); } catch (_) {}
    }
    return response;
  };

  const observer = new MutationObserver(() => {
    document.querySelectorAll('label.secondaryPhoto').forEach(label => {
      const input = label.querySelector('input[type="file"]');
      if (!input) return;
      const textNode = [...label.childNodes].find(n => n.nodeType === Node.TEXT_NODE);
      if (textNode && textNode.nodeValue?.trim() !== '+ Add Additional Photo — keeps main') textNode.nodeValue = '+ Add Additional Photo — keeps main';
      label.title = 'Adds another photo to this shot list item. It does not replace the required main photo.';
    });
    paintAll();
  });

  if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });
})();
