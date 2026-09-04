# SMF v5 Data Preservation Contract

This migration changes the **transport and frontend**, not the system of record.

## Must remain unchanged

1. Backend spreadsheet and all current V4 sheets.
2. Store ID for every existing store.
3. Store Key for every existing store.
4. Existing V4_POE rows.
5. Existing V4_PHOTOS rows.
6. Existing V4_ACTIVITY history.
7. Existing notes and inventory JSON.
8. Existing LIVE and DEMO Drive folders.
9. Existing physical POE files.
10. Current Safe Store Sync behavior.

## Explicit non-destructive design

- `ApiV5.gs` is added as a new Apps Script file; it does not replace Code.gs.
- Existing v4.8.2 functions remain the authority for stores, inventory, statuses, users, admin and client reporting.
- The Worker has no Google Sheets credential and cannot directly clear/rebuild Sheets.
- The Worker uses a short-lived Drive OAuth token issued by the existing Apps Script owner; it does not introduce a second Drive owner or service account.
- Before every photo upload Apps Script authorizes the FIELD user, team/store relationship, finalization state, photo type, exact Drive folder and deterministic filename.
- After Drive upload Apps Script verifies the same user/team/store, upload token, expected folder, expected filename, file existence, non-zero size and authorized parent folder.
- Only after verification is a V4_PHOTOS row appended.
- Main-photo replacement deactivates old metadata only after the new row exists.
- No physical Drive file is deleted by the v5 upload pipeline.

## Rollback

v4.8.2 can stay deployed while v5 is tested. Because both use the same Store Keys, Sheets and Drive hierarchy, switching the frontend back does not require a data rollback.

## Release gate

Do not switch the whole field team until:
1. one OPEN store uploads one photo through v5;
2. Admin sees the same photo in POE;
3. image quality is accepted;
4. Team 1 and Team 2 upload simultaneously;
5. one store is finalized and status appears correctly in the existing backend/client view.
