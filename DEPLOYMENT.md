# Deployment Checklist

## 1. Keep v4.8.2 live

Do not remove the existing Apps Script deployment during the v5 pilot.

Do not run Store Sync merely because v5 is being introduced.

## 2. Google Cloud project

Deploy `api/` to Cloud Run.

Enable:
- Google Sheets API
- Google Drive API

The API is stateless; operational records remain in the existing Sheet and Drive.

## 3. Google credentials

The backend supports Google OAuth refresh-token credentials so Drive files can be created as the authorized Google user.

Set these as Cloud Run secrets/environment variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `BACKEND_SPREADSHEET_ID`
- `POE_ROOT_FOLDER_ID`
- `SESSION_SECRET`
- `ALLOWED_ORIGIN`
- `APP_MODE` (`LIVE` or `DEMO`)

Do **not** commit these values.

## 4. Sheet access

The authorized Google account must already have access to the existing backend spreadsheet and POE root folder.

No sheet copy is required.

## 5. GitHub Pages config

Copy:

`docs/config.example.js` → `docs/config.js`

and set only the public API URL:

```js
window.SMF_CONFIG = {
  API_BASE_URL: "https://YOUR-CLOUD-RUN-SERVICE.run.app"
};
```

The API URL is not a secret.

## 6. Pilot

Use one OPEN store.

Confirm:
- login works;
- store list is correct;
- Store ID and Store Key match the existing backend;
- photo upload returns green confirmation;
- file appears in the existing POE Drive hierarchy;
- new row appears in `V4_PHOTOS`;
- Admin v4.8.2 can see the photo;
- notes/inventory are not lost.

Then test simultaneous Team 1 + Team 2 uploads.

## 7. GitHub Pages

Enable Pages for the `/docs` folder on the main branch only after the pilot branch is reviewed/merged.
