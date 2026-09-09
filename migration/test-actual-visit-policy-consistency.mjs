#!/usr/bin/env node

/**
 * Static regression guard for the locked Actual Visit Date policy.
 *
 * NO NETWORK. NO SHEETS. NO DRIVE. NO WRITES OUTSIDE THE LOCAL RUNNER.
 * This deliberately checks both independent migration consumers until a later
 * reviewed refactor safely centralizes the policy.
 */

import fs from 'node:fs';

const audit = fs.readFileSync('migration/actual-visit-date-audit.mjs', 'utf8');
const builder = fs.readFileSync('migration/build-source-identity-layer.mjs', 'utf8');

function requireText(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`Actual Visit Date policy guard failed: ${label}`);
}
function forbidText(source, needle, label) {
  if (source.includes(needle)) throw new Error(`Actual Visit Date policy guard failed: ${label}`);
}

const statuses = "new Set(['COMPLETED','INCOMPLETE','REFUSED','CLOSED'])";
requireText(audit, statuses, 'audit must recognize the four final visit statuses');
requireText(builder, statuses, 'builder must recognize the four final visit statuses');

requireText(audit, 'explicitNoVisit(note)', 'audit must honor explicit no-visit notes');
requireText(builder, 'explicitNoVisit(note)', 'builder must honor explicit no-visit notes');

requireText(audit, "Installation is not required.", 'audit must keep installation irrelevant to visit occurrence');
requireText(builder, "if(!completedAt||!FINAL_VISIT_STATUSES.has(status)||explicitNoVisit(note))return null;", 'builder must require final status and reject explicit no-visit records');

requireText(audit, 'dateRank(a.visitDate)-dateRank(b.visitDate)', 'audit must select the earliest qualifying visit');
requireText(builder, 'dateRank(visit.visitDate)<dateRank(prev.visitDate)', 'builder must select the earliest qualifying visit');
forbidText(builder, 'dateRank(completed)>dateRank(prev)', 'builder must never restore the old latest-completed rule');

requireText(builder, "merged['Actual Visit Date']=base['Actual Visit Date'];", 'system-computed Actual Visit Date must not fall back to a stale old value');
requireText(builder, "const ACTUAL_VISIT_POLICY = 'EARLIEST_QUALIFYING_FINAL_FIELD_OUTCOME';", 'builder must expose the locked policy in its result');

console.log(JSON.stringify({
  ok: true,
  policy: 'EARLIEST_QUALIFYING_FINAL_FIELD_OUTCOME',
  finalStatuses: ['COMPLETED','INCOMPLETE','REFUSED','CLOSED'],
  installationAffectsVisit: false,
  explicitNoVisitOverrides: true,
  auditEarliestRuleVerified: true,
  builderEarliestRuleVerified: true,
  networkCalls: 0,
  sheetWrites: 0,
  driveWrites: 0
}, null, 2));
