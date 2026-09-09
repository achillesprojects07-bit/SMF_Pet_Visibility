#!/usr/bin/env node

/**
 * SMF Store Identity Safe Sync Engine
 *
 * Compatibility-first design:
 * - STORE IDENTITY & SCHEDULE is the authoritative management/identity source.
 * - Existing records are matched to V4_STORES by Store ID ONLY.
 * - Name, address, route day, date, and stop are never used to identify an existing store.
 * - Existing Store Key is immutable compatibility linkage for V4_POE / V4_PHOTOS.
 * - Existing V4_POE / V4_PHOTOS rows are never rewritten here.
 * - DELETE is not implemented and always remains zero.
 * - Default mode is DRY_RUN and performs Google Sheets GET requests only.
 * - APPLY is hard-gated and deliberately disabled in this migration phase.
 *
 * This file intentionally does NOT touch the field app or photo-v6 worker.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const SOURCE_SHEET_ID = process.env.SOURCE_SHEET_ID || '1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
const INTERNAL_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1TNrb3ir8vS6CyZ8kXhRH43JXoH4Ws7iQ4g3649KQTf0';
const OUT_DIR = process.env.SAFE_SYNC_OUT_DIR || 'migration/safe-sync-output';
const MODE = String(process.env.SAFE_SYNC_MODE || 'DRY_RUN').toUpperCase();
const IDENTITY_SHEET = 'STORE IDENTITY & SCHEDULE';

const REQUIRED_IDENTITY_HEADERS = [
  'Store ID',
  'Current Store Name',
  'Assigned Team',
  'Route Day',
  'Scheduled Deployment Date',
  'Scheduled Stop',
  'Actual Visit Date',
  'Legacy Store Key'
];

const REQUIRED_ADDITIVE_HEADERS = [
  'Route Day',
  'Scheduled Deployment Date',
  'Actual Visit Date'
];

function need(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function norm(v) {
  return String(v ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function teamNorm(v) {
  const m = String(v ?? '').match(/team\s*(\d+)/i);
  return m ? `Team ${m[1]}` : String(v ?? '').trim();
}

function boolNorm(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return ['true', 'yes', '1', 'active'].includes(s) ? 'TRUE' : ['false', 'no', '0', 'inactive'].includes(s) ? 'FALSE' : s.toUpperCase();
}

function dateNorm(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return s;
  const sept = s.match(/^Sept(?:ember)?\s+(\d{1,2})$/i);
  if (sept) return `2026-09-${String(Number(sept[1])).padStart(2, '0')}`;
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slash) return `${slash[3]}-${String(Number(slash[1])).padStart(2, '0')}-${String(Number(slash[2])).padStart(2, '0')}`;
  return s;
}

function rowsToObjects(values) {
  if (!values?.length) return [];
  const headers = values[0].map(v => String(v ?? '').trim());
  return values.slice(1).filter(r => r.some(v => String(v ?? '').trim() !== '')).map((r, rowIndex) => {
    const o = { __row: rowIndex + 2 };
    headers.forEach((h, i) => { if (h) o[h] = r[i] ?? ''; });
    return o;
  });
}

function duplicates(items) {
  const seen = new Set();
  const dup = new Set();
  for (const raw of items) {
    const v = String(raw ?? '').trim();
    if (!v) continue;
    if (seen.has(v)) dup.add(v);
    seen.add(v);
  }
  return [...dup];
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function accessToken() {
  const body = new URLSearchParams({
    client_id: need('GOOGLE_OAUTH_CLIENT_ID'),
    client_secret: need('GOOGLE_OAUTH_CLIENT_SECRET'),
    refresh_token: need('GOOGLE_OAUTH_REFRESH_TOKEN'),
    grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) throw new Error(`Google OAuth refresh failed: ${r.status}`);
  return data.access_token;
}

async function getRange(token, sheetId, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Sheets GET failed ${range}: ${r.status} ${await r.text()}`);
  return (await r.json()).values || [];
}

function compareExistingFields(identity, live) {
  const diffs = [];
  const compare = (field, desired, current, normalize = v => String(v ?? '').trim()) => {
    const d = normalize(desired);
    const c = normalize(current);
    if (d !== c) diffs.push({ field, desired: String(desired ?? '').trim(), current: String(current ?? '').trim() });
  };

  compare('Store Name', identity['Current Store Name'], live['Store Name'], norm);
  compare('Assigned Team', identity['Assigned Team'], live['Assigned Team'], teamNorm);
  compare('Scheduled Deployment Date', identity['Scheduled Deployment Date'], live.Day, dateNorm);
  compare('Stop No.', identity['Scheduled Stop'], live['Stop No.']);
  compare('Store Category', identity['Store Category'], live['Store Category'], norm);
  compare('Address', identity['Street Address / Location'], live.Address, norm);
  compare('Barangay', identity['Barangay / District'], live.Barangay, norm);
  compare('Area', identity['City / Area'], live.Area, norm);
  compare('Material Allocation', identity['Material Allocation'], live['Material Allocation'], norm);
  compare('Active', identity.Active, live.Active, boolNorm);

  return diffs;
}

function buildPlan(identityRows, liveStores) {
  const actions = [];
  const liveById = new Map();
  for (const live of liveStores) {
    const id = String(live['Store ID'] || '').trim();
    if (id && !liveById.has(id)) liveById.set(id, live);
  }

  const duplicateIdentityIds = new Set(duplicates(identityRows.map(r => r['Store ID'])));
  const matchedIds = new Set();

  for (const identity of identityRows) {
    const storeId = String(identity['Store ID'] || '').trim();
    const legacyStoreKey = String(identity['Legacy Store Key'] || '').trim();

    if (!storeId) {
      actions.push({
        action: 'ADD_REVIEW',
        reason: 'BLANK_STORE_ID_REQUIRES_CONTROLLED_NEW_STORE_FLOW',
        identityRow: identity.__row,
        currentName: identity['Current Store Name'],
        team: teamNorm(identity['Assigned Team']),
        routeDay: identity['Route Day'],
        scheduledDate: identity['Scheduled Deployment Date']
      });
      continue;
    }

    if (duplicateIdentityIds.has(storeId)) {
      actions.push({
        action: 'BLOCKED',
        reason: 'DUPLICATE_STORE_ID_IN_IDENTITY_LAYER',
        storeId,
        identityRow: identity.__row,
        currentName: identity['Current Store Name']
      });
      continue;
    }

    const live = liveById.get(storeId);
    if (!live) {
      actions.push({
        action: 'ADD_REVIEW',
        reason: 'STORE_ID_NOT_IN_LIVE_REQUIRES_CONTROLLED_ADD_FLOW',
        storeId,
        identityRow: identity.__row,
        currentName: identity['Current Store Name'],
        team: teamNorm(identity['Assigned Team']),
        routeDay: identity['Route Day'],
        scheduledDate: identity['Scheduled Deployment Date']
      });
      continue;
    }

    matchedIds.add(storeId);
    const liveStoreKey = String(live['Store Key'] || '').trim();
    if (!legacyStoreKey || legacyStoreKey !== liveStoreKey) {
      actions.push({
        action: 'BLOCKED',
        reason: !legacyStoreKey ? 'IDENTITY_LEGACY_STORE_KEY_BLANK' : 'LEGACY_STORE_KEY_MISMATCH_IMMUTABLE',
        storeId,
        identityLegacyStoreKey: legacyStoreKey,
        liveStoreKey,
        currentName: identity['Current Store Name'],
        matchMethod: 'STORE_ID_EXACT'
      });
      continue;
    }

    const diffs = compareExistingFields(identity, live);
    actions.push({
      action: diffs.length ? 'UPDATE' : 'UNCHANGED',
      storeId,
      legacyStoreKey: liveStoreKey,
      currentName: identity['Current Store Name'],
      liveName: live['Store Name'],
      team: teamNorm(identity['Assigned Team']),
      routeDay: identity['Route Day'],
      scheduledDate: identity['Scheduled Deployment Date'],
      actualVisitDate: identity['Actual Visit Date'],
      scheduledStop: identity['Scheduled Stop'],
      matchMethod: 'STORE_ID_EXACT',
      changes: diffs
    });
  }

  for (const live of liveStores) {
    const id = String(live['Store ID'] || '').trim();
    if (id && !matchedIds.has(id)) {
      actions.push({
        action: 'PRESERVE_LIVE_ONLY',
        reason: 'ABSENCE_FROM_IDENTITY_LAYER_NEVER_MEANS_DELETE',
        storeId: id,
        legacyStoreKey: live['Store Key'],
        currentLiveName: live['Store Name']
      });
    }
  }

  return actions;
}

function summarize(actions) {
  const counts = { UNCHANGED: 0, UPDATE: 0, ADD: 0, BLOCKED: 0, PRESERVE_LIVE_ONLY: 0, DELETE: 0 };
  for (const a of actions) {
    if (a.action === 'UNCHANGED') counts.UNCHANGED++;
    else if (a.action === 'UPDATE') counts.UPDATE++;
    else if (a.action === 'ADD_REVIEW') counts.ADD++;
    else if (a.action === 'BLOCKED') counts.BLOCKED++;
    else if (a.action === 'PRESERVE_LIVE_ONLY') counts.PRESERVE_LIVE_ONLY++;
  }
  return counts;
}

function assertApplyGate({ headers, counts, invariants, fingerprint }) {
  if (MODE !== 'APPLY') return;

  const explicit = String(process.env.SAFE_SYNC_APPLY_APPROVED || '') === 'YES_I_APPROVE_NON_DESTRUCTIVE_APPLY';
  if (!explicit) throw new Error('APPLY BLOCKED: SAFE_SYNC_APPLY_APPROVED approval phrase is missing.');

  const expectedFingerprint = String(process.env.SAFE_SYNC_EXPECTED_FINGERPRINT || '').trim();
  if (!expectedFingerprint || expectedFingerprint !== fingerprint) {
    throw new Error('APPLY BLOCKED: production fingerprint changed or was not explicitly supplied. Re-run dry-run.');
  }

  const missingHeaders = REQUIRED_ADDITIVE_HEADERS.filter(h => !headers.includes(h));
  if (missingHeaders.length) {
    throw new Error(`APPLY BLOCKED: additive schema is not ready. Missing V4_STORES headers: ${missingHeaders.join(', ')}`);
  }

  if (counts.DELETE !== 0) throw new Error('APPLY BLOCKED: DELETE must equal 0.');
  if (counts.BLOCKED !== 0) throw new Error(`APPLY BLOCKED: ${counts.BLOCKED} record(s) require manual review.`);
  if (Object.values(invariants).some(v => v !== true)) throw new Error('APPLY BLOCKED: one or more integrity invariants failed.');

  throw new Error('APPLY BLOCKED BY DESIGN: write implementation is not enabled in this phase. Dry-run proof only.');
}

const token = await accessToken();
const [liveValues, poeValues, photoValues, identityValues] = await Promise.all([
  getRange(token, INTERNAL_SHEET_ID, 'V4_STORES!A1:AZ500'),
  getRange(token, INTERNAL_SHEET_ID, 'V4_POE!A1:S2000'),
  getRange(token, INTERNAL_SHEET_ID, 'V4_PHOTOS!A1:N10000'),
  getRange(token, SOURCE_SHEET_ID, `'${IDENTITY_SHEET}'!A1:R1000`)
]);

const headers = (liveValues[0] || []).map(v => String(v ?? '').trim());
const identityHeaders = (identityValues[0] || []).map(v => String(v ?? '').trim());
const missingIdentityHeaders = REQUIRED_IDENTITY_HEADERS.filter(h => !identityHeaders.includes(h));
if (missingIdentityHeaders.length) {
  throw new Error(`Identity layer is not ready. Missing headers: ${missingIdentityHeaders.join(', ')}`);
}

const liveStores = rowsToObjects(liveValues);
const poe = rowsToObjects(poeValues);
const photos = rowsToObjects(photoValues);
const identityRows = rowsToObjects(identityValues);
const livePoe = poe.filter(r => String(r.Environment || '').toUpperCase() === 'LIVE');
const livePhotos = photos.filter(r => String(r.Environment || '').toUpperCase() === 'LIVE');
const liveKeys = new Set(liveStores.map(s => String(s['Store Key'] || '').trim()).filter(Boolean));
const identityIds = identityRows.map(r => String(r['Store ID'] || '').trim());
const liveIds = liveStores.map(r => String(r['Store ID'] || '').trim());

const actions = buildPlan(identityRows, liveStores);
const counts = summarize(actions);
const existingMatchedActions = actions.filter(a => a.matchMethod === 'STORE_ID_EXACT');

const invariants = {
  storeIdUnique: duplicates(liveIds).length === 0,
  storeKeyUnique: duplicates(liveStores.map(s => s['Store Key'])).length === 0,
  noBlankStoreIds: liveStores.every(s => String(s['Store ID'] || '').trim()),
  noBlankStoreKeys: liveStores.every(s => String(s['Store Key'] || '').trim()),
  identityStoreIdUnique: duplicates(identityIds).length === 0,
  noBlankIdentityStoreIds: identityRows.every(r => String(r['Store ID'] || '').trim()),
  identityLegacyStoreKeysPresent: identityRows.every(r => String(r['Legacy Store Key'] || '').trim()),
  allExistingMatchesUseStoreIdOnly: existingMatchedActions.every(a => a.matchMethod === 'STORE_ID_EXACT'),
  allIdentityLegacyKeysMatchLive: existingMatchedActions.every(a => String(a.legacyStoreKey || '') === String(liveStores.find(s => String(s['Store ID'] || '').trim() === a.storeId)?.['Store Key'] || '')),
  allLivePoeKeysResolve: livePoe.every(r => liveKeys.has(String(r['Store Key'] || '').trim())),
  allLivePhotoKeysResolve: livePhotos.every(r => liveKeys.has(String(r['Store Key'] || '').trim())),
  allLivePhotosHaveFileId: livePhotos.every(r => String(r['File ID'] || '').trim()),
  allLivePhotosHaveFolderId: livePhotos.every(r => String(r['Folder ID'] || '').trim()),
  deleteIsZero: counts.DELETE === 0
};

const fingerprintPayload = {
  identity: identityRows.map(r => [
    r['Store ID'], r['Legacy Store Key'], r['Current Store Name'], r['Assigned Team'],
    r['Route Day'], r['Scheduled Deployment Date'], r['Scheduled Stop'], r['Actual Visit Date']
  ]),
  stores: liveStores.map(s => [s['Store ID'], s['Store Key'], s['Store Name'], s['Assigned Team'], s.Day, s['Stop No.']]),
  livePoe: livePoe.map(r => [r['Store Key'], r['Store Status'], r['Updated At']]),
  livePhotos: livePhotos.map(r => [r['Store Key'], r['Photo Type'], r['File ID'], r['Folder ID'], r.Active])
};
const fingerprint = stableHash(fingerprintPayload);

const report = {
  generatedAt: new Date().toISOString(),
  mode: MODE,
  identitySource: IDENTITY_SHEET,
  matchingPolicy: 'EXISTING_STORES_BY_STORE_ID_ONLY',
  writeImplementationEnabled: false,
  totals: {
    identityRows: identityRows.length,
    liveStores: liveStores.length,
    livePoeRows: livePoe.length,
    livePhotoRows: livePhotos.length,
    existingStoreIdMatches: existingMatchedActions.length
  },
  counts,
  invariants,
  fingerprint,
  additiveSchemaReady: REQUIRED_ADDITIVE_HEADERS.every(h => headers.includes(h)),
  missingAdditiveHeaders: REQUIRED_ADDITIVE_HEADERS.filter(h => !headers.includes(h)),
  actions
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(`${OUT_DIR}/safe-sync-plan.json`, JSON.stringify(report, null, 2));
fs.writeFileSync(`${OUT_DIR}/safe-sync-summary.txt`, [
  `mode=${MODE}`,
  `identitySource=${IDENTITY_SHEET}`,
  `matchingPolicy=${report.matchingPolicy}`,
  `identityRows=${report.totals.identityRows}`,
  `liveStores=${report.totals.liveStores}`,
  `existingStoreIdMatches=${report.totals.existingStoreIdMatches}`,
  `livePoeRows=${report.totals.livePoeRows}`,
  `livePhotoRows=${report.totals.livePhotoRows}`,
  `UNCHANGED=${counts.UNCHANGED}`,
  `UPDATE=${counts.UPDATE}`,
  `ADD=${counts.ADD}`,
  `BLOCKED=${counts.BLOCKED}`,
  `PRESERVE_LIVE_ONLY=${counts.PRESERVE_LIVE_ONLY}`,
  `DELETE=${counts.DELETE}`,
  `fingerprint=${fingerprint}`,
  `additiveSchemaReady=${report.additiveSchemaReady}`,
  `missingAdditiveHeaders=${report.missingAdditiveHeaders.join('|')}`,
  ...Object.entries(invariants).map(([k, v]) => `${k}=${v}`)
].join('\n') + '\n');

console.log(JSON.stringify({
  mode: MODE,
  identitySource: IDENTITY_SHEET,
  matchingPolicy: report.matchingPolicy,
  totals: report.totals,
  counts,
  invariants,
  fingerprint,
  additiveSchemaReady: report.additiveSchemaReady,
  missingAdditiveHeaders: report.missingAdditiveHeaders,
  writeImplementationEnabled: false
}, null, 2));

if (Object.values(invariants).some(v => v !== true)) process.exitCode = 2;
assertApplyGate({ headers, counts, invariants, fingerprint });