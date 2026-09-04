# SMF Pet Visibility — v5

Production architecture for the **SMF PET VISIBILITY DEPLOYMENT APP**.

## Architecture

```text
Field phone
   |
   v
GitHub Pages frontend
   |
   v
Cloudflare Worker API
   |--------------------------|
   v                          v
Apps Script v4.8.2 logic      Google Drive photo upload
   |                          ^
   |                          |
   +-- short-lived Drive OAuth token (same Apps Script owner)
   |
   v
Google Sheets
```

## Data-preservation rule

**No data migration is required.** v5 deliberately reuses the current v4.8.2 Google backend.

- Google Sheets remains the system of record.
- Google Drive remains the POE repository.
- Existing Store IDs and Store Keys are unchanged.
- Existing V4_POE and V4_PHOTOS rows are unchanged.
- Existing Drive folders and files are unchanged.
- Safe Store Sync remains in the current Apps Script backend.
- The Worker never writes directly to Sheets.
- The Worker does not require a service account or a second Google Drive owner.
- The Worker uploads photo bytes to the exact folder authorized by Apps Script.
- Apps Script performs the V4_PHOTOS metadata commit and replacement rules.

Do **not** run Store Sync just to move to v5.

## Why v5 fixes the upload architecture

The old field app sent photo data through Apps Script HTML Service. v5 changes the critical path to:

```text
Phone File/Blob -> HTTPS Worker -> Google Drive
                            |
                            -> Apps Script validates + commits V4_PHOTOS metadata
```

The browser gets real upload progress and can retry the same logical upload. The upload token creates a deterministic Drive filename, so a retry reuses the same file if Drive already received it.

## Files

- `index.html` — full field/admin/client frontend migrated from v4.8.2.
- `config.js` — public API URL only; contains no secret.
- `api-worker/worker.js` — API proxy and direct Google Drive upload using a short-lived token issued by the existing Apps Script owner.
- `backend/ApiV5.gs` — additive Apps Script bridge. Add it to the existing v4.8.2 project; do not replace Code.gs.
- `DATA_PRESERVATION.md` — preservation contract and rollout safeguards.
- `DEPLOYMENT.md` — exact deployment steps.

## Current state

The code is prepared for deployment. It will intentionally show “API is not configured” until the Worker URL is placed in `config.js`.
