#!/usr/bin/env node

/**
 * SMF Store Identity Safe Sync Engine
 *
 * Compatibility-first design:
 * - Store ID is the future canonical identity.
 * - Existing Store Key is immutable compatibility linkage.
 * - Existing V4_POE / V4_PHOTOS rows are never rewritten here.
 * - DELETE is not implemented.
 * - Default mode is DRY_RUN and performs GET requests only.
 * - APPLY is hard-gated and currently refuses to run until the additive schema exists.
 *
 * This file intentionally does NOT touch the field app or photo-v6 worker.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const SOURCE_SHEET_ID = process.env.SOURCE_SHEET_ID || '1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
const INTERNAL_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1TNrb3ir8vS6CyZ8kXhRH43JXoH4Ws7iQ4g3649KQTf0';
const OUT_DIR = process.env.SAFE_SYNC_OUT_DIR || 'migration/safe-sync-output';
const MODE = String(process.env.SAFE_SYNC_MODE || 'DRY_RUN').toUpperCase();

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

function rowsToObjects(values) {
  if (!values?.length) return [];
  const headers = values[0].map(v => String(v ?? '').trim());
  return values.slice(1).filter(r => r.some(v => String(v ?? '').trim() !== '')).map((r, rowIndex) => {
    const o = { __row: rowIndex + 2 };
    headers.forEach((h, i) => { if (h) o[h] = r[i] ?? ''; });
    return o;
  });
}

function legacyNameFromKey(key) {
  const parts = String(key ?? '').split('|');
  return parts.length >= 4 ? parts.slice(3).join('|').trim() : '';
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

function safeMatchSourceToLive(src, liveStores) {
  const team = teamNorm(src['Assigned Team']);
  const name = norm(src['Store Name']);
  const address = norm(src['Street Address / Location']);
  const sameTeam = liveStores.filter(s => teamNorm(s['Assigned Team']) === team);

  const nameMatches = sameTeam.filter(s => {
    const liveName = norm(s['Store Name']);
    const legacyName = norm(legacyNameFromKey(s['Store Key']));
    return name && (name === liveName || name === legacyName);
  });
  if (nameMatches.length === 1) return { kind: 'MATCH', method: 'TEAM+NAME_OR_LEGACY_NAME', store: nameMatches[0] };
  if (nameMatches.length > 1) return { kind: 'BLOCK', reason: 'AMBIGUOUS_NAME', matches: nameMatches };

  const addressMatches = sameTeam.filter(s => address && address === norm(s['Address']));
  if (addressMatches.length === 1) return { kind: 'MATCH', method: 'TEAM+ADDRESS', store: addressMatches[0] };
  if (addressMatches.length > 1) return { kind: 'BLOCK', reason: 'AMBIGUOUS_ADDRESS', matches: addressMatches };

  return { kind: 'ADD', method: 'NO_SAFE_MATCH' };
}

function buildPlan(source, liveStores) {
  const actions = [];
  const matchedIds = new Set();

  for (const src of source) {
    const match = safeMatchSourceToLive(src, liveStores);
    if (match.kind === 'BLOCK') {
      actions.push({
        action: 'BLOCKED',
        reason: match.reason,
        sourceName: src['Store Name'],
        team: teamNorm(src['Assigned Team']),
        routeDay: src.Day,
        sourceStop: src['Stop No.'],
        sourceAddress: src['Street Address / Location'],
        candidates: match.matches.map(s => ({ storeId: s['Store ID'], storeKey: s['Store Key'], name: s['Store Name'] }))
      });
      continue;
    }

    if (match.kind === 'ADD') {
      actions.push({
        action: 'ADD_REVIEW',
        reason: 'NEW_STORE_REQUIRES_NEW_PERMANENT_STORE_ID',
        sourceName: src['Store Name'],
        team: teamNorm(src['Assigned Team']),
        routeDay: src.Day,
        sourceStop: src['Stop No.'],
        sourceAddress: src['Street Address / Location'],
        allocation: src['Material Allocation']
      });
      continue;
    }

    const live = match.store;
    matchedIds.add(String(live['Store ID'] || '').trim());
    const sourceName = String(src['Store Name'] || '').trim();
    const liveName = String(live['Store Name'] || '').trim();
    const legacyName = legacyNameFromKey(live['Store Key']);
    const sourceEqualsLive = norm(sourceName) === norm(liveName);
    const sourceEqualsLegacy = norm(sourceName) === norm(legacyName);

    if (!sourceEqualsLive && sourceEqualsLegacy) {
      // The source still contains an older name while production already has a newer display name.
      // Never auto-revert the production name.
      actions.push({
        action: 'BLOCKED',
        reason: 'SOURCE_NAME_IS_LEGACY_NAME_DO_NOT_REVERT_CURRENT_NAME',
        storeId: live['Store ID'],
        legacyStoreKey: live['Store Key'],
        sourceName,
        currentLiveName: liveName,
        legacyName,
        team: teamNorm(src['Assigned Team']),
        routeDay: src.Day,
        scheduledDate: live.Day,
        matchMethod: match.method
      });
      continue;
    }

    if (!sourceEqualsLive) {
      actions.push({
        action: 'BLOCKED',
        reason: 'NAME_DIFFERENCE_REQUIRES_MANUAL_IDENTITY_REVIEW',
        storeId: live['Store ID'],
        legacyStoreKey: live['Store Key'],
        sourceName,
        currentLiveName: liveName,
        team: teamNorm(src['Assigned Team']),
        routeDay: src.Day,
        scheduledDate: live.Day,
        matchMethod: match.method
      });
      continue;
    }

    actions.push({
      action: 'UNCHANGED',
      storeId: live['Store ID'],
      legacyStoreKey: live['Store Key'],
      sourceName,
      currentLiveName: liveName,
      team: teamNorm(src['Assigned Team']),
      routeDay: src.Day,
      scheduledDate: live.Day,
      sourceStop: src['Stop No.'],
      liveStop: live['Stop No.'],
      matchMethod: match.method
    });
  }

  for (const live of liveStores) {
    const id = String(live['Store ID'] || '').trim();
    if (id && !matchedIds.has(id)) {
      actions.push({
        action: 'PRESERVE_LIVE_ONLY',
        reason: 'ABSENCE_FROM_SOURCE_NEVER_MEANS_DELETE',
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

  // Deliberate safety stop for this migration phase.
  // The schema must first be added and separately verified before an apply implementation is enabled.
  throw new Error('APPLY BLOCKED BY DESIGN: write implementation is not enabled in this phase. Dry-run proof only.');
}

const token = await accessToken();
const [liveValues, poeValues, photoValues, sourceValues] = await Promise.all([
  getRange(token, INTERNAL_SHEET_ID, 'V4_STORES!A1:AZ500'),
  getRange(token, INTERNAL_SHEET_ID, 'V4_POE!A1:S2000'),
  getRange(token, INTERNAL_SHEET_ID, 'V4_PHOTOS!A1:N10000'),
  getRange(token, SOURCE_SHEET_ID, "'STORE MASTER + MATERIALS'!A1:L1000")
]);

const headers = (liveValues[0] || []).map(v => String(v ?? '').trim());
const liveStores = rowsToObjects(liveValues);
const poe = rowsToObjects(poeValues);
const photos = rowsToObjects(photoValues);
const source = rowsToObjects(sourceValues);
const livePoe = poe.filter(r => String(r.Environment || '').toUpperCase() === 'LIVE');
const livePhotos = photos.filter(r => String(r.Environment || '').toUpperCase() === 'LIVE');
const liveKeys = new Set(liveStores.map(s => String(s['Store Key'] || '').trim()).filter(Boolean));

const actions = buildPlan(source, liveStores);
const counts = summarize(actions);

const invariants = {
  storeIdUnique: duplicates(liveStores.map(s => s['Store ID'])).length === 0,
  storeKeyUnique: duplicates(liveStores.map(s => s['Store Key'])).length === 0,
  noBlankStoreIds: liveStores.every(s => String(s['Store ID'] || '').trim()),
  noBlankStoreKeys: liveStores.every(s => String(s['Store Key'] || '').trim()),
  allLivePoeKeysResolve: livePoe.every(r => liveKeys.has(String(r['Store Key'] || '').trim())),
  allLivePhotoKeysResolve: livePhotos.every(r => liveKeys.has(String(r['Store Key'] || '').trim())),
  allLivePhotosHaveFileId: livePhotos.every(r => String(r['File ID'] || '').trim()),
  allLivePhotosHaveFolderId: livePhotos.every(r => String(r['Folder ID'] || '').trim()),
  deleteIsZero: counts.DELETE === 0
};

const fingerprintPayload = {
  stores: liveStores.map(s => [s['Store ID'], s['Store Key'], s['Store Name'], s['Assigned Team'], s.Day, s['Stop No.']]),
  livePoe: livePoe.map(r => [r['Store Key'], r['Store Status'], r['Updated At']]),
  livePhotos: livePhotos.map(r => [r['Store Key'], r['Photo Type'], r['File ID'], r['Folder ID'], r.Active])
};
const fingerprint = stableHash(fingerprintPayload);

const report = {
  generatedAt: new Date().toISOString(),
  mode: MODE,
  writeImplementationEnabled: false,
  totals: {
    sourceRows: source.length,
    liveStores: liveStores.length,
    livePoeRows: livePoe.length,
    livePhotoRows: livePhotos.length
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
  `sourceRows=${report.totals.sourceRows}`,
  `liveStores=${report.totals.liveStores}`,
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
