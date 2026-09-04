# SMF Photo V6 — Direct Google Transport

## Purpose

Photo upload no longer depends on Apps Script for photo setup, Drive folder placement, or `V4_PHOTOS` metadata synchronization.

The new path is:

`Field app -> Cloudflare Photo V6 Worker -> Google Drive API + Google Sheets API`

Apps Script is used only once when a field user signs in, to bootstrap the existing access-code/team/store assignment session. It is not called during photo upload.

## Data preservation

This build does **not** delete, migrate, rename, or overwrite historical Drive files. It preserves the existing POE root hierarchy and appends compatible rows to the existing `V4_PHOTOS` sheet. A new main photo only marks the previous main-photo row inactive; the physical old Drive file remains intact.

The current production Field app remains on the existing photo transport until V6 is configured and tested. This provides a rollback point.

## One-time Google setup

Create one Google Cloud service account for SMF Pet Visibility Photo V6 and enable:

- Google Drive API
- Google Sheets API

Share the existing SMF POE root Drive folder with the service-account email as **Editor**.

Share the existing deployment Google Sheet with the same service-account email as **Editor**.

Create/download one service-account JSON key. Keep the private key secret.

## Required GitHub repository secrets

The existing Cloudflare/bridge secrets remain in place. Add these four values to the repository secrets:

- `GOOGLE_SERVICE_ACCOUNT_EMAIL` — `client_email` from the service-account JSON
- `GOOGLE_PRIVATE_KEY` — `private_key` from the service-account JSON
- `GOOGLE_SHEET_ID` — ID from the existing SMF deployment spreadsheet URL
- `POE_ROOT_FOLDER_ID` — ID of the existing SMF POE root Drive folder

Existing secrets reused by V6:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `SCRIPT_API_URL`
- `BRIDGE_SECRET`

## Deployment

Run GitHub Actions workflow **Deploy SMF Photo V6**.

The workflow automatically:

1. checks that all required secrets exist;
2. finds or creates Cloudflare D1 database `smf-pet-visibility-photo-v6`;
3. applies the transaction-ledger migration;
4. binds D1 to the Worker as `DB`;
5. deploys `smf-pet-visibility-photo-v6`;
6. injects Google and bridge credentials as Worker secrets.

No `ApiV5.gs` deployment is required for V6 photo transport.

## Transaction states

Every photo gets one permanent `upload_id` in D1:

- `RESERVED` — correct existing store folder resolved and Drive file shell created
- `DRIVE_SAVED` — Google Drive confirmed real bytes
- `METADATA_PENDING` — image is safe; Sheets synchronization can retry without uploading the photo again
- `COMPLETE` — Drive + `V4_PHOTOS` are both confirmed

The `upload_id` is also stored in `V4_PHOTOS` Notes as `V6_UPLOAD:<upload_id>` to make retries idempotent across Worker restarts.

## Cutover rule

Do not point the Field app to V6 until all of these pass:

1. `/v6/health` returns `directGoogle: true` and `appsScriptPhotoPath: false`.
2. One new photo reaches `COMPLETE` and appears in the correct existing store folder and `V4_PHOTOS`.
3. Repeating the same upload ID does not create a duplicate Drive file or duplicate sheet row.
4. A forced Sheets failure leaves the transaction at `METADATA_PENDING`, then `/sync` completes it without re-uploading bytes.
5. Two field users can upload simultaneously to different stores.

Only after those tests should `PHOTO_API_BASE_URL` be enabled in the Field frontend.
