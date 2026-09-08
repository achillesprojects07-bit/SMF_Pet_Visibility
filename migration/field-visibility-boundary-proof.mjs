#!/usr/bin/env node

/**
 * Field Visibility Boundary Proof — READ ONLY / FAIL CLOSED.
 *
 * Purpose:
 * Prove whether a staged V4_STORES row with Active=FALSE is guaranteed to be
 * invisible to every Field path before production add-store APPLY can unlock.
 *
 * Current architecture trace:
 * field frontend -> api-worker -> Apps Script ApiV5 bridge -> getFieldHomeV4 / getStoreV4
 * The implementations of getFieldHomeV4/getStoreV4 live in the existing v4.8.2
 * Apps Script Code.gs and are intentionally not present in this repository.
 *
 * Therefore this proof MUST fail closed unless the filtering implementation is
 * made auditable here or an explicit external verification artifact is supplied.
 * It never writes Sheets, Drive, Apps Script, Worker state, or production data.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const OUT_DIR=process.env.FIELD_VISIBILITY_PROOF_OUT_DIR||'migration/field-visibility-proof-output';
const MODE='READ_ONLY_FIELD_VISIBILITY_PROOF';
const FIELD_VISIBILITY_BOUNDARY_PROVEN=false;
const PRODUCTION_APPLY_MAY_UNLOCK=false;

function text(v){return String(v??'');}
function hash(v){return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');}
function exists(p){return fs.existsSync(p);}
function read(p){return exists(p)?fs.readFileSync(p,'utf8'):'';}
function includesAll(s,parts){return parts.every(p=>s.includes(p));}

function buildProof(){
  const files={
    fieldFrontend:exists('app.js'),
    apiWorker:exists('api-worker/worker.js'),
    apiBridge:exists('backend/ApiV5.gs'),
    legacyBackendImplementation:exists('backend/Code.gs')||exists('Code.gs')
  };
  const worker=read('api-worker/worker.js');
  const bridge=read('backend/ApiV5.gs');
  const executor=read('migration/manual-one-store-apply-executor.mjs');

  const trace={
    workerAllowsFieldHome:worker.includes("'getFieldHomeV4'"),
    workerAllowsStoreRead:worker.includes("'getStoreV4'"),
    bridgeDelegatesFieldHome:bridge.includes("'getFieldHomeV4':getFieldHomeV4"),
    bridgeDelegatesStoreRead:bridge.includes("'getStoreV4':getStoreV4"),
    bridgeDefinesFieldHome:/function\s+getFieldHomeV4\s*\(/.test(bridge),
    bridgeDefinesStoreRead:/function\s+getStoreV4\s*\(/.test(bridge),
    executorStillHardLocked:includesAll(executor,[
      'PRODUCTION_APPLY_UNLOCKED=false',
      'FIELD_VISIBILITY_CONTAINMENT_PROVEN=false'
    ])
  };

  const missingProof=[];
  if(!files.legacyBackendImplementation) missingProof.push('Authoritative getFieldHomeV4/getStoreV4 implementation is not present in this repository.');
  if(!trace.bridgeDefinesFieldHome) missingProof.push('ApiV5.gs delegates getFieldHomeV4 but does not define its filtering behavior.');
  if(!trace.bridgeDefinesStoreRead) missingProof.push('ApiV5.gs delegates getStoreV4 but does not define its filtering behavior.');
  missingProof.push('No independently verified live test exists proving an Active=FALSE staged store is excluded from Field home, direct store open, and photo-session store maps.');

  const boundary={
    activeFalseGuaranteedHidden:false,
    fieldHomeBoundaryProven:false,
    directStoreBoundaryProven:false,
    photoSessionBoundaryProven:false,
    productionApplyUnlockPermitted:false,
    requiredContainmentStrategy:'NO_V4_STORES_STAGING_UNTIL_FIELD_BOUNDARY_IS_PROVEN',
    safeInterimStrategy:'KEEP_NEW_STORE_AS_IMMUTABLE_MANIFEST_ARTIFACT_ONLY'
  };

  const invariants={
    readOnly:true,
    noProductionWrites:true,
    noDriveWrites:true,
    noUploadRuntimeChanges:true,
    executorHardLockStillPresent:trace.executorStillHardLocked,
    fieldBoundaryFailClosed:FIELD_VISIBILITY_BOUNDARY_PROVEN===false,
    productionApplyMustRemainLocked:PRODUCTION_APPLY_MAY_UNLOCK===false
  };

  const report={
    generatedAt:new Date().toISOString(),mode:MODE,
    fieldVisibilityBoundaryProven:FIELD_VISIBILITY_BOUNDARY_PROVEN,
    productionApplyMayUnlock:PRODUCTION_APPLY_MAY_UNLOCK,
    files,trace,boundary,missingProof,invariants
  };
  report.fingerprint=hash(report);
  return report;
}

function selfTest(){
  const synthetic={worker:"'getFieldHomeV4' 'getStoreV4'",bridge:"'getFieldHomeV4':getFieldHomeV4,'getStoreV4':getStoreV4"};
  const tests={
    delegationIsNotImplementation:!(/function\s+getFieldHomeV4\s*\(/.test(synthetic.bridge)),
    failClosed:FIELD_VISIBILITY_BOUNDARY_PROVEN===false,
    applyLocked:PRODUCTION_APPLY_MAY_UNLOCK===false
  };
  if(Object.values(tests).some(v=>v!==true))throw new Error('SELF TEST FAILED '+JSON.stringify(tests));
  return {ok:true,tests};
}

if(process.argv.includes('--self-test')){
  console.log(JSON.stringify(selfTest(),null,2));
}else{
  const report=buildProof();
  fs.mkdirSync(OUT_DIR,{recursive:true});
  fs.writeFileSync(`${OUT_DIR}/field-visibility-boundary-proof.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({
    mode:report.mode,
    fieldVisibilityBoundaryProven:report.fieldVisibilityBoundaryProven,
    productionApplyMayUnlock:report.productionApplyMayUnlock,
    trace:report.trace,
    boundary:report.boundary,
    missingProof:report.missingProof,
    invariants:report.invariants,
    fingerprint:report.fingerprint
  },null,2));
  if(Object.values(report.invariants).some(v=>v!==true))process.exitCode=2;
}
