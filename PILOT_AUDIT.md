# SMF v5 Field Pilot — Preservation & Consistency Audit

## Release posture

This branch is a **parallel pilot**. It is intentionally not wired to production yet. `docs/config.js` has a blank `API_BASE_URL`, so the GitHub frontend cannot write to the Google backend until the Cloud Run API is explicitly deployed and connected.

The current Apps Script v4.8.2 deployment remains the rollback/fallback path.

## Preservation checks

PASS — v5 does not create a new store database.

PASS — `V4_STORES` is read-only from the v5 field API.

PASS — existing `Store ID` and `Store Key` are read and reused; the v5 field API contains no code that regenerates them.

PASS — `V4_POE` is updated in place by the existing Environment + Store Key relationship. Unspecified columns are preserved by header-based row updates.

PASS — inventory continues to use `Beginning JSON`, `Installed JSON`, and `Take Home JSON` (Remaining).

PASS — `V4_PHOTOS` remains the photo metadata table.

PASS — existing Store Folder ID is resolved from photo history before a new folder is created. This protects renamed stores from folder duplication.

PASS — photo replacement never deletes or trashes the previous Drive file. The new photo is uploaded and registered first; previous MAIN metadata is then marked inactive.

PASS — no Store Sync runs or is required for v5.

PASS — no delete-row, delete-file, trash-file, clear-sheet, or rebuild-store operation exists in the v5 field API.

## Field workflow checks

PASS — FIELD accounts only.

PASS — team assignment is checked on each store action.

PASS — active sessions are revalidated against `V4_USERS`; disabling a user or changing their team invalidates the session.

PASS — final visit outcomes remain `COMPLETED`, `INCOMPLETE`, `REFUSED`, and backend `CLOSED` (visible STORE CLOSED).

PASS — COMPLETED uses the same inventory invariants as v4.8.2: non-negative quantities, Beginning <= Allocated, and Beginning = Installed + Remaining.

PASS — COMPLETED requires all required MAIN POE slots.

PASS — REFUSED and STORE CLOSED require Notes + Storefront.

PASS — INCOMPLETE requires Notes + Storefront + at least one non-storefront evidence photo.

PASS — SUBMIT DAY remains blocked while any store in the Team/Day is OPEN.

## Photo transport checks

PASS — browser sends the selected photo as binary multipart form data.

PASS — no base64 image transport is used.

PASS — the browser displays upload progress.

PASS — one automatic network retry reuses the same upload token.

PASS — backend uses deterministic upload-token filenames; if Drive succeeded but metadata did not, retry can reuse the same Drive file.

PASS — if metadata succeeded but the response was lost, retry finds the existing `UPLOAD_TOKEN` row and returns it instead of writing a duplicate active record.

PASS — MAIN and EXTRA photo types remain schema-compatible with the existing app.

PASS — additional evidence cannot falsely satisfy a missing MAIN photo in the v5 UI.

## Security checks

PASS — no spreadsheet ID, Drive root ID, access code, OAuth secret, refresh token, or session secret is committed to the repository.

PASS — production secrets are environment/Secret Manager values.

PASS — login attempts are throttled.

PASS — session tokens are signed and expire.

PASS — every authenticated request revalidates the user against `V4_USERS`.

NOTE — the repository is currently PUBLIC. Keep it free of production identifiers/secrets, or change the repository visibility to private before adding operational configuration.

## Static validation

Local syntax checks passed for:
- `docs/app.js`
- `docs/sw.js`
- `api/src/google.js`
- `api/src/domain.js`
- `api/src/server.js`

## Intentional pilot limitations

The first v5 branch is **field-only** to isolate and prove the new upload transport without risking Admin/Client regressions. Admin and Client continue to use v4.8.2 against the same backend during the pilot.

The first pilot does not replace every Admin function and is not a reason to retire v4.8.2.

## Mandatory live gate before field rollout

1. Deploy the Cloud Run API with secrets outside GitHub.
2. Set the public API URL in `docs/config.js`.
3. Pilot one OPEN store only.
4. Confirm Store ID and Store Key match the existing record.
5. Upload one MAIN photo.
6. Confirm the same file appears in the existing POE Drive folder and a new active row appears in `V4_PHOTOS`.
7. Confirm Admin v4.8.2 sees the same photo.
8. Verify inventory and Notes were not altered by photo capture/upload.
9. Test replace MAIN photo and confirm old physical Drive file remains.
10. Test one additional evidence photo.
11. Test simultaneous Team 1 + Team 2 uploads.
12. Only after all checks pass should the GitHub frontend be released to the field team.
