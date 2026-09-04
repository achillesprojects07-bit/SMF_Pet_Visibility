(() => {
  'use strict';

  // Read-only compatibility guard for additional POE photos.
  // It never uploads, deletes, renames, moves, or edits Drive/Sheets data.
  // Its only job is to ensure an EXTRA__ photo can never be presented as the
  // required main photo when legacy getStoreV4 data is rendered by app.js.

  const nativeFetch = window.fetch.bind(window);
  const EXTRA_PREFIX = 'EXTRA__';

  function exactMain(group, baseType) {
    if (!Array.isArray(group)) return null;
    const base = String(baseType || '').toUpperCase();
    return group.find(p => String(p?.type || '').toUpperCase() === base) || null;
  }

  function normalizeStoreResult(result) {
    if (!result || typeof result !== 'object') return result;
    const groups = result.photoGroups && typeof result.photoGroups === 'object' ? result.photoGroups : {};
    const photos = result.photos && typeof result.photos === 'object' ? { ...result.photos } : {};
    const required = Array.isArray(result.requiredPhotos) ? result.requiredPhotos : [];

    required.forEach(req => {
      const base = String(req?.type || '').toUpperCase();
      if (!base) return;
      const group = Array.isArray(groups[base]) ? groups[base] : [];
      const main = exactMain(group, base);
      if (main) {
        photos[base] = main;
        return;
      }
      // If legacy grouping accidentally promoted an EXTRA__ row to photos[base],
      // remove only that presentation alias. The underlying row/file is untouched.
      if (String(photos[base]?.type || '').toUpperCase().startsWith(EXTRA_PREFIX)) {
        delete photos[base];
      }
    });

    result.photos = photos;
    return result;
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
    if (!isGetStore) return response;

    try {
      const data = await response.clone().json();
      if (data && data.ok !== false && data.result) normalizeStoreResult(data.result);
      return new Response(JSON.stringify(data), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (_) {
      return response;
    }
  };

  // Make the intent unambiguous in the UI without changing app.js upload logic.
  const observer = new MutationObserver(() => {
    document.querySelectorAll('label.secondaryPhoto').forEach(label => {
      const input = label.querySelector('input[type="file"]');
      if (!input) return;
      let textNode = [...label.childNodes].find(n => n.nodeType === Node.TEXT_NODE);
      if (textNode && textNode.nodeValue?.trim() !== '+ Add Additional Photo — keeps main') {
        textNode.nodeValue = '+ Add Additional Photo — keeps main';
      }
      label.title = 'Adds another photo to this shot list item. It does not replace the required main photo.';
    });
  });

  if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });
})();
