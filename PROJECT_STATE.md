# SMF Pet Visibility — Authoritative Project State

**Last reconstructed:** 2026-09-08
**Repository:** `achillesprojects07-bit/SMF_Pet_Visibility`
**Default branch:** `main`
**Authority:** This file is the handoff/source-of-truth for future ChatGPT/Codex work. Before proposing a roadmap or editing code, read this file, the latest commits, and the files named below.

---

## 1. Project goal

SMF PET VISIBILITY DEPLOYMENT APP supports:

- FIELD deployment teams doing store visits, inventory, notes, status and POE photo capture;
- ADMIN monitoring deployment, stores, POE, issues, users and system health;
- CLIENT reporting with a clean read-only progress/store/POE experience.

The project is already substantially built. **Do not restart it, redesign it from scratch, or invent a new phase without first checking current code and this state file.**

---

## 2. Current architecture — preserve

Current production/pilot architecture:

```text
Field phone / Admin / Client
        |
        v
GitHub Pages frontend
        |
        v
Cloudflare Worker API
        |
        +--> Apps Script v4.8.2 business logic
        |        |
        |        v
        |    Google Sheets
        |
        +--> Google Drive POE upload path
```

Photo upload evolved into the V6 path while retaining the same underlying business data and Drive ownership model.

### Non-negotiable preservation rules

Do not casually modify or migrate:

- Google Sheets system of record;
- existing V4 sheets;
- Store IDs;
- Store Keys;
- existing V4_POE rows;
- existing V4_PHOTOS rows;
- existing V4_ACTIVITY rows;
- existing notes/inventory data;
- existing LIVE/DEMO Drive folder structure and physical files;
- Safe Store Sync behavior;
- working field photo upload architecture.

UX changes must be isolated from working backend/upload behavior unless a verified bug requires otherwise.

---

## 3. KEEP TILE SUMMARY — locked Client UX

The chat/project state known as **KEEP TILE SUMMARY** is the authoritative UX direction for the Client view.

### Locked decisions

1. **Keep the tile summary** as the primary at-a-glance visual summary.
2. Retain six top metrics:
   - Total Stores
   - Completed
   - Incomplete
   - Refused
   - Store Closed
   - Not Started
3. Keep overall Deployment Progress below the metric tiles.
4. Remove the old/messy **By Deployment Day** card summary from the Client UX.
5. Store discovery must use clear filters for:
   - Team
   - Deployment Day
   - Area
   - Status
6. Keep a separate store search field.
7. Store results should be clean cards, not a dense client table.
8. Opening a store must use a large modal/panel rather than dumping detail at the bottom of the page.
9. Store detail must show:
   - store identity/context;
   - current visit/final status;
   - finalized date/time;
   - finalized by;
   - notes;
   - beginning inventory;
   - installed inventory;
   - remaining inventory;
   - POE photo gallery.
10. POE thumbnails/photos must be clickable.
11. Show a prominent **Open this store’s POE folder** action when a folder URL is available.
12. Closing/back from the store modal must return the user to the same underlying store list/filter state.
13. Avoid clutter and unnecessary summary blocks.

### Current implementation check

`client.js` currently implements this direction:

- six metric tiles;
- Deployment Progress;
- Team / Deployment Day / Area / Status filters;
- separate search;
- store cards;
- modal store detail;
- notes and inventory;
- clickable POE gallery;
- store-specific POE folder link;
- back-to-stores modal close without re-rendering/resetting filters.

**Therefore future work must not reintroduce the removed By Deployment Day client card section or replace the current Client flow with a dense table.**

---

## 4. Latest actual repository state

At reconstruction time, HEAD on `main` is:

`533d733ac5302ca3ea9a707dff5b62a2a277726e` — **Make Admin store opening explicit and reliable**

The latest sequence of work focused on stabilizing store opening and POE/photo-count behavior while preserving the field workflow.

Recent important commits include:

- `533d733` — Make Admin store opening explicit and reliable
- `f6429ad` — Remove unused submit-status guard and preserve field workflow
- `edb2b5a` — Keep Admin store detail visible without touching field workflow
- `10dbd09` — Show submitted store status and refresh schedule safely
- `bf5e5b5` — Guard against photo-count render loops
- `6fbfa04` — Fix photo count guard render loop blocking store opening
- `2dc7c2e` — Guard live per-shot photo counts and preserve V6 uploader
- `4726835` — Show live per-shot POE photo counts without changing uploader
- `28d66c9` — Guard non-destructive additional-photo compatibility fix

### Important implication

The latest work was **not** a new architecture or new Client redesign. It was a reliability/stability pass around store opening and photo display/count behavior.

---

## 5. Current Admin state

`admin.js` currently provides:

- deployment overview metrics;
- deployment progress;
- By Day and By Area admin reporting;
- Stores & POE view;
- store search;
- Team / Day / Status filters;
- explicit OPEN button plus row-click behavior;
- store detail showing visit status, finalized by/at, notes, inventory and POE;
- reopen-for-correction action for finalized stores;
- issue inspection flow;
- users/system/admin operations.

The newest commit made Admin store opening explicit and reliable by adding an OPEN button and delegated click handling while preserving row-click behavior.

Do not remove that reliability fix without reproducing and proving a better interaction.

---

## 6. Current Client state

Files:

- `client.html`
- `client.css`
- `client.js`

Current flow:

```text
Client login
  -> summary tiles
  -> deployment progress
  -> Store Report & POE
  -> filters/search
  -> store cards
  -> large store modal
  -> visit/notes + inventory + POE + store folder
  -> Back to stores
```

This is the current locked KEEP TILE SUMMARY direction.

---

## 7. Current Field / POE stability state

Do not treat the photo uploader as disposable UI code.

The repository contains explicit stability/preservation work including:

- V6 photo deployment workflow;
- photo-extra compatibility guard;
- live per-shot photo counts;
- render-loop guards;
- folder provisioning;
- stability-guard workflow;
- deterministic/non-destructive photo behavior.

The existing preservation contract states that physical Drive files are not deleted by the upload pipeline and metadata replacement must be non-destructive.

### Additional-photo rule

Exact/main shot types and additional/extra photos must remain distinguishable. Compatibility work around `EXTRA__...` photos must not cause existing main POE or uploaded files to be lost, overwritten incorrectly, or hidden unintentionally.

---

## 8. What is considered DONE / locked

Unless a reproducible bug proves otherwise, treat these as complete decisions rather than open brainstorming:

- core GitHub Pages + Worker + Google backend architecture;
- Client KEEP TILE SUMMARY direction;
- removal of the old Client By Deployment Day summary cards;
- Client filter/search structure;
- Client store-card list;
- Client modal detail pattern;
- clickable POE gallery;
- store-specific POE folder access;
- non-destructive data preservation rules;
- explicit Admin store-open reliability fix;
- photo-count render-loop protection;
- preserving V6 upload behavior while improving display/count UI.

---

## 9. Open verification / next engineering step

**Do not begin a new phase yet.**

The next correct action is a targeted regression verification of the latest stability build, especially the most recently changed Admin/store-opening and POE-count paths.

Verify in this order:

1. Client page still matches KEEP TILE SUMMARY exactly.
2. Client filters and search do not reset when a store modal is opened/closed.
3. Client store modal opens reliably from multiple filtered store cards.
4. Client POE thumbnails open the intended image and store-folder button opens the correct store folder.
5. Admin store row and explicit OPEN button both open the same correct store.
6. Admin store detail remains visible and does not disappear because of a render/update loop.
7. FIELD can open a store normally after the photo-count guard changes.
8. Per-shot live photo counts update without a render loop.
9. Additional/EXTRA photos remain additional and do not replace/hide the exact main shot incorrectly.
10. Existing uploaded photos, notes, inventory and finalized statuses remain intact.
11. No regression to V6 upload, Drive folders, OAuth/D1/photo metadata path.

Only after these pass should the next UX or feature phase be chosen.

---

## 10. Rules for any future AI/programmer continuing this repo

Before editing:

1. Read `PROJECT_STATE.md`.
2. Read latest 10–20 commits.
3. Inspect the exact files involved.
4. State what is already done and what exact bug/change is being addressed.
5. Preserve working architecture and data.
6. Make the smallest safe change first.
7. Do not reintroduce previously rejected UX.
8. Do not call something a backend bug unless verified.
9. Do not rewrite the photo system to solve a display-only problem.
10. After a meaningful accepted change, update this file with:
    - latest accepted state;
    - new commit SHA;
    - what changed;
    - what remains;
    - exact next action.

---

## 11. Source-of-truth priority

When sources disagree, use this order:

1. **Current deployed/reproducible behavior**
2. **Current `main` branch code and latest commits**
3. **`PROJECT_STATE.md`**
4. `DATA_PRESERVATION.md` / current architecture docs
5. Older chat summaries or historical README text

Older documentation may describe earlier pilot architecture and can be stale. Never overwrite newer working behavior merely to make it match an old document.

---

## 12. Handoff sentence for a new ChatGPT chat

Use:

> Continue the SMF Pet Visibility project from the repository. Read `PROJECT_STATE.md` and the latest commits before proposing or changing anything. KEEP TILE SUMMARY is the locked Client UX. Do not restart the roadmap, reintroduce rejected UX, or touch working V6/upload/data-preservation architecture unless a reproduced bug requires it. First tell me the current state and exact next engineering action from the repository.
