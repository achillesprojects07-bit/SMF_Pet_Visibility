# SMF Pet Visibility — Production Readiness Audit

Date: 2026-09-09
Branch: `main`

## Release principle

Protect production data and the proven V6 photo upload architecture above all other improvements. No upload-path, Drive hierarchy, POE metadata, Store ID, Store Key, or destructive migration change is part of this audit.

## Admin

### Verified in code / previously confirmed live
- Overview status tiles navigate to the matching Stores & POE filter.
- Stores can be opened by row or OPEN button.
- Store detail shows identity, status, notes, inventory and active POE photos.
- Back-to-store-list behavior preserves the existing list/filter state because the list is not rebuilt when detail is closed.
- Store detail now uses dedicated page mode rather than showing the store list behind it.
- Programmatic detail opens are protected too (Issues → Inspect Store and the post-reopen refresh path).
- Visit terminology is display-only: Submitted by / Submitted on. Technical `updatedAt` remains preserved in backend data but is not shown in the normal Admin visit panel.
- Reopen for Correction remains an explicit Admin-only write action.

### Live confirmation still required
- Issues → Inspect Store opens the same isolated detail page and Back returns correctly.
- Reopen for Correction should only be live-tested on a deliberately selected real correction case because it changes production state.
- Users and System tabs should receive final human UX confirmation.

## Field

### Verified in code
- Finalized store inventory inputs are disabled.
- Finalized store notes are disabled.
- Finalized stores do not show photo upload/remove controls.
- Submit Store Visit is blocked while a photo upload is running.
- Submit Store Visit is blocked while saved-photo metadata is still syncing.
- Back navigation is blocked while upload/sync work is active.
- V6 photo session, retry/recovery and pending metadata mechanisms remain intact.
- Existing upload architecture was not modified by this audit.

### Live confirmation still required
- One normal store visit flow from open → draft → photos → final submit.
- One Admin-authorized correction flow when a genuine correction is needed.
- Confirm extra photos remain extras and do not replace required main photos.
- Confirm retry/recovery on a real weak-network case if encountered naturally.

## Client

### Verified in code
- Six summary tiles remain the primary visual summary.
- Team, Deployment Day, Area and Status filters remain present.
- Store search remains separate.
- Store cards open a large detail modal.
- Closing the modal does not rebuild the dashboard, so current filters/search remain intact.
- Detail contains status, finalized information, notes, inventory, POE gallery and POE folder link when available.
- POE photos open individually.

### Live confirmation still required
- Compare several sample stores against Admin for status, inventory, notes and POE count.
- Mobile/tablet final visual pass.

## Cross-application integrity gate

Before production lock, sample stores across COMPLETED, INCOMPLETE, REFUSED and CLOSED must agree across Field/Admin/Client on:
- Store identity
- Visit outcome/status
- Notes
- Beginning / Installed / Remaining inventory
- Active POE photos

## Correction workflow gate

Required behavior:

`Field submits → visit locks → Admin explicitly Reopens for Correction → Field edits → Field resubmits → visit locks again`

Do not create a fake production correction merely to test this gate. Use the first genuine correction case or an explicitly authorized test record.

## Migration / new-store gate

- Live production remains the existing legitimate store set.
- Do not create a synthetic production store.
- `store-id-compat-audit` remains separate and must not be merged without explicit approval.
- Do not rely on inactive-store staging in the deployed legacy Field runtime.
- New Store ID / Legacy Store Key / POE folder / materials must be proven as one controlled transaction when a genuine new store exists.

## Frozen systems

Unless a reproducible production defect requires otherwise, do not modify:
- `app.js` V6 field upload flow
- `photo-v6/worker.js`
- `api-worker/worker.js`
- `backend/ApiV5.gs`
- existing Drive/POE folder architecture

## Current release decision

Admin/Field/Client are feature-complete enough for production lock. Remaining work is verification and controlled correction/new-store proof, not broad redesign.
