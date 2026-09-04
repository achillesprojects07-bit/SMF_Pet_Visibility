let cachedGoogleToken = null;

// v5 pilot is deliberately FIELD-only. Admin, Client, Safe Store Sync and
// destructive/demo utilities remain available only through the existing v4.8.2 app.
const ACTION_ALLOWLIST = new Set([
  'loginV4',
  'getFieldHomeV4',
  'getStoreV4',
  'saveStoreV4',
  'submitStoreVisitV4',
  'submitDayV4',
  'removePhotoV4',
  'rescheduleStoreV4'
]);

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGIN || '').trim();
  const allowOrigin = (!allowed || allowed === '*') ? '*' : (origin === allowed ? origin : '');
  const h = {
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store'
  };
  if (allowOrigin) h['Access-Control-Allow-Origin'] = allowOrigin;
  return h;
}

function jsonResponse(request, env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(request, env) }
  });
}

function assertOrigin(request, env) {
  const allowed = String(env.ALLOWED_ORIGIN || '').trim();
  if (!allowed || allowed === '*') return;
  const origin = request.headers.get('Origin') || '';
  if (origin !== allowed) throw new Error('Origin is not allowed.');
}

async function callAppsScript(env, action, args) {
  const url = String(env.SCRIPT_API_URL || '').trim();
  const secret = String(env.BRIDGE_SECRET || '').trim();
  if (!url || !secret) throw new Error('API bridge is not configured.');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bridgeSecret: secret, action, args }),
    redirect: 'follow'
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error('Apps Script bridge returned an unreadable response.'); }
  if (!data || data.ok === false) throw new Error((data && data.error) || 'Apps Script bridge failed.');
  return data.result;
}

async function getGoogleAccessToken(env, forceFresh = false) {
  const now = Date.now();
  if (!forceFresh && cachedGoogleToken && cachedGoogleToken.expiresAt > now + 60000) {
    return cachedGoogleToken.token;
  }
  const r = await callAppsScript(env, 'getDriveUploadTokenV5', []);
  const token = String(r && r.accessToken || '');
  if (!token) throw new Error('Apps Script did not provide a Google Drive upload token.');
  // Cache conservatively; retry once with a fresh token on Drive 401.
  cachedGoogleToken = { token, expiresAt: now + 35 * 60 * 1000 };
  return token;
}

async function driveFetch(env, url, init = {}, retry401 = true) {
  let token = await getGoogleAccessToken(env, false);
  let r = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` }
  });
  if (r.status === 401 && retry401) {
    token = await getGoogleAccessToken(env, true);
    r = await fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` }
    });
  }
  return r;
}

function driveQueryEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findDriveFile(env, folderId, name) {
  const q = `'${driveQueryEscape(folderId)}' in parents and name='${driveQueryEscape(name)}' and trashed=false`;
  const url = 'https://www.googleapis.com/drive/v3/files?spaces=drive&supportsAllDrives=true&includeItemsFromAllDrives=true' +
    '&fields=files(id,name,mimeType,size,webViewLink)&pageSize=10&q=' + encodeURIComponent(q);
  const r = await driveFetch(env, url);
  const data = await r.json();
  if (!r.ok) throw new Error('Could not check Google Drive for an existing upload.');
  return (data.files || [])[0] || null;
}

async function createDriveShell(env, folderId, name, mime) {
  const r = await driveFetch(env, 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: [folderId], mimeType: mime || 'image/jpeg' })
  });
  const data = await r.json();
  if (!r.ok || !data.id) throw new Error('Google Drive could not create the photo file.');
  return data;
}

async function uploadDriveMedia(env, fileId, file, mime) {
  const r = await driveFetch(env, `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink`, {
    method: 'PATCH',
    headers: { 'Content-Type': mime || file.type || 'application/octet-stream' },
    body: file.stream()
  });
  const data = await r.json();
  if (!r.ok || !data.id) throw new Error('Google Drive did not finish saving the photo.');
  return data;
}

async function ensureDrivePhoto(env, prep, file) {
  // Deterministic filename lets a retry reuse a file already created by Drive.
  let existing = await findDriveFile(env, prep.folderId, prep.fileName);
  if (!existing) existing = await createDriveShell(env, prep.folderId, prep.fileName, prep.mime || file.type);
  const currentSize = Number(existing.size || 0);
  if (currentSize !== Number(file.size || 0) || currentSize === 0) {
    existing = await uploadDriveMedia(env, existing.id, file, prep.mime || file.type);
  }
  return existing;
}

async function handleAction(request, env) {
  const body = await request.json();
  const action = String(body.action || '');
  if (!ACTION_ALLOWLIST.has(action)) throw new Error('API action is not allowed in the v5 field pilot.');
  const args = Array.isArray(body.args) ? body.args : [];
  return await callAppsScript(env, action, args);
}

async function handlePhoto(request, env) {
  const form = await request.formData();
  const file = form.get('photoFile');
  if (!(file instanceof File)) throw new Error('No photo was received.');
  if (file.size <= 0) throw new Error('The selected photo is empty.');
  if (file.size > 12 * 1024 * 1024) throw new Error('This photo is over 12 MB. Please retake it using the normal phone camera.');

  const code = String(form.get('accessCode') || '').trim();
  const p = {
    storeKey: String(form.get('storeKey') || ''),
    photoType: String(form.get('photoType') || ''),
    addAnother: String(form.get('addAnother') || '') === '1',
    uploadToken: String(form.get('uploadToken') || ''),
    originalName: String(file.name || ''),
    mime: String(file.type || 'application/octet-stream'),
    size: Number(file.size || 0)
  };

  // Apps Script validates user/team/store/type and authorizes the exact folder/name.
  const prep = await callAppsScript(env, 'prepareExternalPhotoV5', [code, p]);
  if (prep && prep.alreadyCommitted) return prep;

  // Photo bytes bypass Apps Script HTML Service and go directly to Drive.
  const drive = await ensureDrivePhoto(env, prep, file);

  // Apps Script re-validates everything before V4_PHOTOS is changed.
  const commitPayload = {
    ...p,
    folderId: prep.folderId,
    fileName: prep.fileName,
    fileId: drive.id
  };
  return await callAppsScript(env, 'commitExternalPhotoV5', [code, commitPayload]);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    try {
      assertOrigin(request, env);
      const url = new URL(request.url);
      if (request.method !== 'POST') return jsonResponse(request, env, { ok: false, error: 'Method not allowed.' }, 405);
      if (url.pathname === '/api/action') {
        const result = await handleAction(request, env);
        return jsonResponse(request, env, { ok: true, result });
      }
      if (url.pathname === '/api/photo') {
        const result = await handlePhoto(request, env);
        return jsonResponse(request, env, { ok: true, result });
      }
      return jsonResponse(request, env, { ok: false, error: 'Not found.' }, 404);
    } catch (err) {
      return jsonResponse(request, env, { ok: false, error: String(err && err.message ? err.message : err) }, 400);
    }
  }
};
