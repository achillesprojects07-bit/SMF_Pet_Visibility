# SMF Pet Visibility — v5 Field Pilot

This repository contains the **new field frontend and upload API** for the SMF Pet Visibility deployment app.

## Preservation rule

**v5 does not migrate, clear, rebuild, rename, or replace the existing Google Sheets/Drive data.**

The existing Google backend remains the system of record:

- `V4_STORES`
- `V4_POE`
- `V4_PHOTOS`
- `V4_ACTIVITY`
- `V4_USERS`
- `V4_CONFIG`
- `V4_MERCH_RULES`

Existing **Store ID**, **Store Key**, POE rows, inventory, notes, photo metadata, and Drive folders remain unchanged.

The current Apps Script v4.8.2 app can remain live as the fallback while v5 is piloted.

## Architecture

```text
Field phone
   |
   v
GitHub Pages PWA
   |
   | HTTPS / multipart file upload
   v
Cloud Run API (stateless)
   |                    \
   | Sheets API          \ Drive API
   v                      v
Existing Google Sheet    Existing POE Drive folders
```

### Why this fixes the weak upload path

The photo is sent as a **binary multipart file**, not a base64 string and not through Apps Script HTML Service.

The API authenticates against existing `V4_USERS`, preserves Store ID/Store Key, reuses existing photo folders, and writes into the existing `V4_POE` / `V4_PHOTOS` tables.

Physical Drive files are **never deleted** by photo replacement.

## Safe pilot

v5 is intentionally **field-only first**. Admin and Client can continue using v4.8.2 during the pilot because both versions use the same Google backend.

## Security

This repository must contain **no access codes, spreadsheet IDs, Drive IDs, OAuth refresh tokens, client secrets, or session secrets**.

All sensitive values belong in Cloud Run environment variables / Secret Manager.

> Note: this repository is currently public. Do not commit production IDs or secrets.
