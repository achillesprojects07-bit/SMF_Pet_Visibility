let cachedGoogleToken = null;

// v5 serves Field and Admin. High-risk store sync, mode switches and demo reset
// remain intentionally excluded from the Worker allowlist during active deployment.
const ACTION_ALLOWLIST = new Set([
  // Shared authentication
  'loginV4',

  // Field
  'getFieldHomeV4',
  'getStoreV4',
  'saveStoreV4',
  'submitStoreVisitV4',
  'submitDayV4',
  'removePhotoV4',
  'rescheduleStoreV4',

  // Admin — dashboard, POE review, users, rules and correction workflow
  'getAdminDashboardV4',
  'getAdminIssuesV4',
  'getPoeIndexV4',
  'getAdminStoreV4',
  'reopenStoreVisitV4',
  'getUsersV4',
  'createUserV4',
  'setUserActiveV4',
  'setUserTeamV4',
  'resetUserCodeV4',
  'getRulesV4',
  'setStoreGuideV4',
  'setCategoryGuideV4',
  'getSystemV4',
  'photoUploadHealthV4',
  'healthV4',
  'createOrResetClientAccessV4'
]);

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGIN || '').trim();
  const allowOrigin = (!allowed || allowed === '*') ? '*' : (origin === allowed ? origin : '');
  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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

async function getDriveFile(env, fileId) {
  const r = await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,parents`);
  const data = await r.json();
  if (!r.ok || !data.id) throw new Error('Could not verify the reserved Google Drive photo file.');
  return data;
}

async function uploadDriveMedia(env, fileId, file, mime) {
  const r = await driveFetch(env, `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,parents`, {
    method: 'PATCH',
    headers: { 'Content-Type': mime || file.type || 'application/octet-stream' },
    body: file.stream()
  });
  const data = await r.json();
  if (!r.ok || !data.id) throw new Error('Google Drive did not finish saving the photo.');
  return data;
}

async function ensureDrivePhoto(env, prep, file) {
  const fileId = String(prep && prep.fileId || '');
  if (!fileId) throw new Error('Apps Script did not reserve a Drive file for this upload.');
  let existing = await getDriveFile(env, fileId);
  const currentSize = Number(existing.size || 0);
  if (currentSize !== Number(file.size || 0) || currentSize === 0) {
    existing = await uploadDriveMedia(env, fileId, file, prep.mime || file.type);
  }
  return existing;
}

async function handleAction(request, env) {
  const body = await request.json();
  const action = String(body.action || '');
  if (!ACTION_ALLOWLIST.has(action)) throw new Error('API action is not allowed.');
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

  const prep = await callAppsScript(env, 'prepareExternalPhotoV5', [code, p]);
  if (prep && prep.alreadyCommitted) return prep;
  const drive = await ensureDrivePhoto(env, prep, file);
  const commitPayload = { ...p, folderId: prep.folderId, fileName: prep.fileName, fileId: drive.id };
  return await callAppsScript(env, 'commitExternalPhotoV5', [code, commitPayload]);
}

async function handleHealth(request, env) {
  const bridge = await callAppsScript(env, 'getBridgeHealthV5', []);
  return jsonResponse(request, env, { ok: true, workerVersion: '5.0.1', bridge });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    try {
      assertOrigin(request, env);
      const url = new URL(request.url);
      if (url.pathname === '/api/health' && request.method === 'GET') return await handleHealth(request, env);
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
