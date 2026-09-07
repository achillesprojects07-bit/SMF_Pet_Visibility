#!/usr/bin/env node

/**
 * SMF Store Identity Compatibility Audit
 * READ-ONLY by design: this file performs only Google Sheets GET requests.
 * It never writes to Sheets, Drive, Apps Script, Cloudflare, or the field app.
 *
 * Purpose:
 * - make Store ID the canonical identity for future sync design
 * - preserve every existing legacy Store Key
 * - reconcile source Route Day against live Scheduled Date
 * - identify renames, additions, and ambiguous rows without mutating production
 * - prove V4_POE / V4_PHOTOS referential integrity before any migration write exists
 */

import fs from 'node:fs';

const SOURCE_SHEET_ID = process.env.SOURCE_SHEET_ID || '1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
const INTERNAL_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1TNrb3ir8vS6CyZ8kXhRH43JXoH4Ws7iQ4g3649KQTf0';
const OUT_DIR = process.env.AUDIT_OUT_DIR || 'migration/audit-output';

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
  return values.slice(1).filter(r => r.some(v => String(v ?? '').trim() !== '')).map(r => {
    const o = {};
    headers.forEach((h, i) => { if (h) o[h] = r[i] ?? ''; });
    return o;
  });
}

function legacyNameFromKey(key) {
  const parts = String(key ?? '').split('|');
  return parts.length >= 4 ? parts.slice(3).join('|').trim() : '';
}

function uniqueDuplicates(items) {
  const seen = new Set();
  const dup = new Set();
  for (const item of items) {
    const x = String(item ?? '').trim();
    if (!x) continue;
    if (seen.has(x)) dup.add(x);
    seen.add(x);
  }
  return [...dup].sort();
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
  if (!r.ok || !data.access_token) throw new Error(`Google OAuth refresh failed: ${r.status} ${JSON.stringify(data)}`);
  return data.access_token;
}

async function getRange(token, sheetId, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Sheets GET failed ${range}: ${r.status} ${await r.text()}`);
  const data = await r.json();
  return data.values || [];
}

function matchSourceToLive(source, liveStores) {
  const sourceTeam = teamNorm(source['Assigned Team']);
  const sourceName = norm(source['Store Name']);
  const sourceAddress = norm(source['Street Address / Location']);

  const sameTeam = liveStores.filter(s => teamNorm(s['Assigned Team']) === sourceTeam);
  const nameMatches = sameTeam.filter(s => {
    const liveName = norm(s['Store Name']);
    const legacyName = norm(legacyNameFromKey(s['Store Key']));
    return sourceName && (sourceName === liveName || sourceName === legacyName);
  });

  if (nameMatches.length === 1) return { status: 'MATCHED', method: 'TEAM+NAME/LEGACY_NAME', store: nameMatches[0] };
  if (nameMatches.length > 1) return { status: 'BLOCKED', method: 'AMBIGUOUS_TEAM+NAME', matches: nameMatches };

  const addressMatches = sameTeam.filter(s => sourceAddress && sourceAddress === norm(s['Address']));
  if (addressMatches.length === 1) return { status: 'MATCHED', method: 'TEAM+ADDRESS', store: addressMatches[0] };
  if (addressMatches.length > 1) return { status: 'BLOCKED', method: 'AMBIGUOUS_TEAM+ADDRESS', matches: addressMatches };

  return { status: 'ADD_CANDIDATE', method: 'NO_SAFE_MATCH' };
}

function mdEscape(v) {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

const token = await accessToken();

const [liveValues, poeValues, photoValues, sourceValues] = await Promise.all([
  getRange(token, INTERNAL_SHEET_ID, 'V4_STORES!A1:R500'),
  getRange(token, INTERNAL_SHEET_ID, 'V4_POE!A1:S1000'),
  getRange(token, INTERNAL_SHEET_ID, 'V4_PHOTOS!A1:N5000'),
  getRange(token, SOURCE_SHEET_ID, "'STORE MASTER + MATERIALS'!A1:L500")
]);

const liveStores = rowsToObjects(liveValues);
const poe = rowsToObjects(poeValues);
const photos = rowsToObjects(photoValues);
const source = rowsToObjects(sourceValues);

const liveKeySet = new Set(liveStores.map(s => String(s['Store Key'] || '').trim()).filter(Boolean));
const storeIdDuplicates = uniqueDuplicates(liveStores.map(s => s['Store ID']));
const storeKeyDuplicates = uniqueDuplicates(liveStores.map(s => s['Store Key']));
const blankStoreIds = liveStores.filter(s => !String(s['Store ID'] || '').trim());
const blankStoreKeys = liveStores.filter(s => !String(s['Store Key'] || '').trim());
const unresolvedPoe = poe.filter(r => String(r.Environment || '').toUpperCase() === 'LIVE' && !liveKeySet.has(String(r['Store Key'] || '').trim()));
const unresolvedPhotos = photos.filter(r => String(r.Environment || '').toUpperCase() === 'LIVE' && !liveKeySet.has(String(r['Store Key'] || '').trim()));
const livePhotos = photos.filter(r => String(r.Environment || '').toUpperCase() === 'LIVE');
const blankLivePhotoFileIds = livePhotos.filter(r => !String(r['File ID'] || '').trim());
const blankLivePhotoFolderIds = livePhotos.filter(r => !String(r['Folder ID'] || '').trim());

const reconciled = source.map(src => {
  const match = matchSourceToLive(src, liveStores);
  if (match.status === 'MATCHED') {
    const s = match.store;
    const legacyName = legacyNameFromKey(s['Store Key']);
    const renameDetected = norm(src['Store Name']) !== norm(s['Store Name']);
    const legacyNameDiffers = norm(legacyName) !== norm(s['Store Name']);
    return {
      classification: renameDetected ? 'UPDATE_REVIEW' : 'UNCHANGED',
      matchMethod: match.method,
      storeId: s['Store ID'],
      legacyStoreKey: s['Store Key'],
      sourceName: src['Store Name'],
      currentLiveName: s['Store Name'],
      legacyName,
      renameDetected,
      historicalRenameAlreadyPresent: legacyNameDiffers,
      team: teamNorm(src['Assigned Team']),
      routeDay: src.Day,
      routeStop: src['Stop No.'],
      scheduledDate: s.Day,
      liveStop: s['Stop No.'],
      address: s.Address,
      sourceAddress: src['Street Address / Location'],
      allocationSource: src['Material Allocation'],
      allocationLive: s['Material Allocation']
    };
  }
  if (match.status === 'BLOCKED') {
    return {
      classification: 'BLOCKED',
      matchMethod: match.method,
      sourceName: src['Store Name'],
      team: teamNorm(src['Assigned Team']),
      routeDay: src.Day,
      routeStop: src['Stop No.'],
      sourceAddress: src['Street Address / Location'],
      candidateStoreIds: match.matches.map(s => s['Store ID'])
    };
  }
  return {
    classification: 'ADD_CANDIDATE',
    matchMethod: match.method,
    sourceName: src['Store Name'],
    team: teamNorm(src['Assigned Team']),
    routeDay: src.Day,
    routeStop: src['Stop No.'],
    sourceAddress: src['Street Address / Location'],
    allocationSource: src['Material Allocation']
  };
});

const matchedIds = new Set(reconciled.map(r => r.storeId).filter(Boolean));
const liveOnly = liveStores.filter(s => !matchedIds.has(s['Store ID'])).map(s => ({
  classification: 'LIVE_ONLY_PRESERVE',
  storeId: s['Store ID'],
  legacyStoreKey: s['Store Key'],
  currentLiveName: s['Store Name'],
  team: s['Assigned Team'],
  scheduledDate: s.Day,
  liveStop: s['Stop No.']
}));

const counts = {};
for (const r of [...reconciled, ...liveOnly]) counts[r.classification] = (counts[r.classification] || 0) + 1;
counts.DELETE = 0;

const invariants = {
  storeIdUnique: storeIdDuplicates.length === 0,
  storeKeyUnique: storeKeyDuplicates.length === 0,
  noBlankStoreIds: blankStoreIds.length === 0,
  noBlankStoreKeys: blankStoreKeys.length === 0,
  allLivePoeKeysResolve: unresolvedPoe.length === 0,
  allLivePhotoKeysResolve: unresolvedPhotos.length === 0,
  allLivePhotosHaveFileId: blankLivePhotoFileIds.length === 0,
  allLivePhotosHaveFolderId: blankLivePhotoFolderIds.length === 0,
  deleteIsAlwaysZero: counts.DELETE === 0
};

const hardFailures = Object.entries(invariants).filter(([, ok]) => !ok).map(([name]) => name);

const report = {
  generatedAt: new Date().toISOString(),
  mode: 'READ_ONLY_COMPATIBILITY_AUDIT',
  sourceSheetId: SOURCE_SHEET_ID,
  internalSheetId: INTERNAL_SHEET_ID,
  totals: {
    sourceRows: source.length,
    liveStores: liveStores.length,
    livePoeRows: poe.filter(r => String(r.Environment || '').toUpperCase() === 'LIVE').length,
    livePhotoRows: livePhotos.length
  },
  counts,
  invariants,
  diagnostics: {
    duplicateStoreIds: storeIdDuplicates,
    duplicateStoreKeys: storeKeyDuplicates,
    blankStoreIds: blankStoreIds.map(s => s['Store Name']),
    blankStoreKeys: blankStoreKeys.map(s => s['Store Name']),
    unresolvedPoeKeys: [...new Set(unresolvedPoe.map(r => r['Store Key']))],
    unresolvedPhotoKeys: [...new Set(unresolvedPhotos.map(r => r['Store Key']))],
    blankLivePhotoFileIdCount: blankLivePhotoFileIds.length,
    blankLivePhotoFolderIdCount: blankLivePhotoFolderIds.length
  },
  reconciliation: reconciled,
  liveOnlyPreserved: liveOnly
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(`${OUT_DIR}/store-identity-audit.json`, JSON.stringify(report, null, 2));

const summary = [];
summary.push('# SMF Store Identity Compatibility Audit');
summary.push('');
summary.push(`Generated: ${report.generatedAt}`);
summary.push('');
summary.push('**READ ONLY. No Sheet, Drive, Apps Script, Worker, photo, POE, or app data was modified.**');
summary.push('');
summary.push('## Totals');
summary.push('');
summary.push(`- Source rows: ${report.totals.sourceRows}`);
summary.push(`- Live stores: ${report.totals.liveStores}`);
summary.push(`- Live POE rows: ${report.totals.livePoeRows}`);
summary.push(`- Live photo rows: ${report.totals.livePhotoRows}`);
summary.push(`- DELETE: ${counts.DELETE}`);
summary.push('');
summary.push('## Invariants');
summary.push('');
for (const [k, ok] of Object.entries(invariants)) summary.push(`- ${ok ? 'PASS' : 'FAIL'} — ${k}`);
summary.push('');
summary.push('## Classification');
summary.push('');
for (const [k, v] of Object.entries(counts).sort()) summary.push(`- ${k}: ${v}`);
summary.push('');
summary.push('## Reconciliation');
summary.push('');
summary.push('| Class | Store ID | Source name | Current live name | Route Day | Scheduled Date | Match |');
summary.push('|---|---|---|---|---|---|---|');
for (const r of reconciled) {
  summary.push(`| ${mdEscape(r.classification)} | ${mdEscape(r.storeId)} | ${mdEscape(r.sourceName)} | ${mdEscape(r.currentLiveName)} | ${mdEscape(r.routeDay)} | ${mdEscape(r.scheduledDate)} | ${mdEscape(r.matchMethod)} |`);
}
if (liveOnly.length) {
  summary.push('');
  summary.push('## Live-only records preserved');
  summary.push('');
  for (const r of liveOnly) summary.push(`- ${mdEscape(r.storeId)} — ${mdEscape(r.currentLiveName)} — ${mdEscape(r.legacyStoreKey)}`);
}

fs.writeFileSync(`${OUT_DIR}/store-identity-audit.md`, summary.join('\n') + '\n');

console.log(JSON.stringify({ totals: report.totals, counts, invariants, hardFailures }, null, 2));
if (hardFailures.length) process.exitCode = 2;
