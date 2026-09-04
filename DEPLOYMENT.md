# Deployment — SMF v5

v5 is designed for a parallel, non-destructive cutover.

## Phase 1 — Keep v4.8.2 live

Do not remove the current Apps Script web app. It is the rollback path.

## Phase 2 — Add the bridge to the existing Apps Script project

1. Open the same Apps Script project that currently runs v4.8.2.
2. Add a **new script file** named `ApiV5.gs`.
3. Paste `backend/ApiV5.gs` into it.
4. Do not replace or clear Code.gs.
5. In **Project Settings > Script Properties**, add:
   - `API_BRIDGE_SECRET` = a long random secret.
6. Deploy a new version of the same web app.
7. Deploy to **Execute as: Me**.
8. Copy the `/exec` URL. This becomes `SCRIPT_API_URL`.

## Phase 3 — Confirm Apps Script Drive authorization

The Worker does **not** use a separate Google service account and does not need ownership of your Drive files.

`ApiV5.gs` obtains a short-lived Drive OAuth token from the same Apps Script owner that already has access to the current POE folder. This keeps new v5 photos under the same Google account/access model as the existing app.

Important:
1. The existing project already uses `DriveApp`; accept any Google authorization prompt when the new deployment is created.
2. Do not move or re-share the POE root folder for v5.

## Phase 4 — Deploy Cloudflare Worker

In GitHub repository secrets add:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `SCRIPT_API_URL`
- `BRIDGE_SECRET` — same value as Apps Script `API_BRIDGE_SECRET`

Run the **Deploy SMF API Worker** workflow.

Copy the Worker URL.

## Phase 5 — Point GitHub Pages to the Worker

Edit `config.js`:

```js
window.SMF_CONFIG = {
  API_BASE_URL: 'https://your-worker.workers.dev'
};
```

Enable GitHub Pages for the `main` branch/root.

## Phase 6 — Controlled test

Do not run Store Sync.

Test:
1. one OPEN store;
2. one real field phone;
3. storefront photo;
4. green upload confirmation;
5. photo visible in existing Admin POE;
6. inspect Drive original and client preview;
7. Team 1 + Team 2 simultaneous upload;
8. inventory + notes save;
9. Submit Store Visit;
10. Submit Day behavior.

Only after those pass should the field team move from the Apps Script frontend to the GitHub Pages frontend.
