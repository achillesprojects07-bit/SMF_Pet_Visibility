# SMF v5 Preservation & Architecture Audit

## Decision

v5 is a **parallel field pilot**, not a data migration.

The existing Apps Script v4.8.2 backend remains the authority for all Google Sheets records and business rules. The v5 frontend changes only the browser delivery layer and the photo-byte transport path.

## Preservation checks

- No spreadsheet is recreated.
- No V4 sheet is renamed.
- No Store ID is regenerated.
- No Store Key is regenerated.
- No existing V4_POE row is cleared.
- No existing V4_PHOTOS row is cleared.
- No existing V4_ACTIVITY row is cleared.
- No existing Drive file is deleted by v5 photo upload/replacement.
- Existing Drive folder IDs are reused when present.
- New folders use the same LIVE/DEMO → Team → Area → Store hierarchy as v4.8.2.
- Main-photo replacement appends/registers the new photo before old main metadata is made inactive.
- Worker has no direct Google Sheets credentials.
- Worker cannot call Admin, Client, Safe Store Sync, reset/demo, user-management or mode-management actions in the field pilot.
- Apps Script bridge is also limited to field-pilot actions.
- Photo prepare and photo commit both re-authenticate the FIELD user and verify team/store ownership.
- Finalized stores reject new photo commits.
- Deterministic upload-token filenames prevent duplicate active uploads on retry.
- A zero-byte Drive shell from an interrupted upload is reused and completed on retry rather than creating a second logical upload.

## Photo path

```text
Phone File/Blob
   ↓
GitHub Pages field UI
   ↓ multipart HTTPS
Cloudflare Worker
   ↓ binary media upload
Google Drive
   ↓ verified file ID/folder/name
Apps Script ApiV5 bridge
   ↓
V4_PHOTOS metadata
```

The large photo bytes do **not** pass through Apps Script HTML Service.

## Google authorization model

The Worker requests a short-lived OAuth token from the existing Apps Script owner through the secret-protected bridge. Google documents that `ScriptApp.getOAuthToken()` may be used to call Google APIs when the script has the required scopes. The existing deployment already uses DriveApp, so the same Google account/access model is retained.

## Pilot restrictions

- Field frontend only in v5 pilot.
- Admin and Client remain on v4.8.2 during pilot.
- Do not run Store Sync for the v5 cutover.
- Do not use v4.8.2 and v5 simultaneously to edit the **same OPEN store visit**; pick one frontend for that visit to avoid last-write-wins draft overwrites.
- Keep v4.8.2 deployed as immediate rollback until v5 passes the live release gate.

## Required live gate

1. One OPEN store, one real field phone, one photo.
2. Confirm upload progress and green ✓.
3. Confirm photo exists in the same expected Drive folder.
4. Confirm Admin v4.8.2 sees the same photo in POE.
5. Confirm original image quality is acceptable.
6. Test Team 1 and Team 2 simultaneous uploads.
7. Save notes/inventory and verify they remain unchanged after photo upload.
8. Submit Store Visit and verify existing client/admin reporting sees the same final outcome.
9. Test retry after intentionally interrupting one upload.
10. Only then move the whole field team to v5.
