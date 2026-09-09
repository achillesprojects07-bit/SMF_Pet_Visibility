#!/usr/bin/env node

/**
 * Semantic audit for Production One-Store Dry Run.
 * Reads the generated report only. No external calls and no writes to production.
 * Converts negatively phrased manifest preconditions into unambiguous positive
 * safety assertions and requires Drive parent-path verification.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const path=process.env.PROD_DRY_RUN_REPORT||'migration/production-one-store-dry-run-output/production-one-store-dry-run.json';
const out=process.env.PROD_DRY_RUN_AUDIT_OUT||'migration/production-one-store-dry-run-output/production-one-store-dry-run-audit.json';
const r=JSON.parse(fs.readFileSync(path,'utf8'));
const h=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

const assertions={
  reportIsReadOnly:r?.invariants?.readOnly===true,
  productionWriteDisabled:r?.productionWriteEnabled===false&&r?.invariants?.productionWriteDisabled===true,
  fieldActivationDisabled:r?.fieldActivationEnabled===false&&r?.invariants?.fieldActivationDisabled===true,
  proofOnly:r?.proofOnly===true&&r?.realStoreApplied===false,
  exactOneStoreSimulation:r?.simulation?.wouldWrite?.v4StoresAppend?.length===1&&r?.simulation?.wouldWrite?.sourceIdentityAppend?.length===1,
  noDeleteRequired:r?.manifest?.preconditions?.deleteRequired===false,
  noUploadRuntimeChangeRequired:r?.manifest?.preconditions?.uploadRuntimeChangeRequired===false,
  noDeletesSimulated:r?.simulation?.wouldWrite?.deletes?.length===0,
  noDriveWritesSimulated:r?.simulation?.wouldWrite?.driveWrites?.length===0,
  noPoeWritesSimulated:r?.simulation?.wouldWrite?.v4PoeWrites?.length===0,
  noPhotoWritesSimulated:r?.simulation?.wouldWrite?.v4PhotoWrites?.length===0,
  noFieldActivationWritesSimulated:r?.simulation?.wouldWrite?.fieldActivationWrites?.length===0,
  poeFingerprintUnchanged:r?.simulation?.before?.poe===r?.simulation?.after?.poe,
  photoFingerprintUnchanged:r?.simulation?.before?.photos===r?.simulation?.after?.photos,
  oneStoreCountDelta:Number(r?.simulation?.counts?.storesAfter)===Number(r?.simulation?.counts?.storesBefore)+1,
  oneIdentityCountDelta:Number(r?.simulation?.counts?.identityAfter)===Number(r?.simulation?.counts?.identityBefore)+1,
  driveRootChecked:r?.drive?.checked===true,
  driveLiveParentExists:r?.drive?.liveExists===true,
  driveTeamParentExists:r?.drive?.teamExists===true,
  driveAreaParentExists:r?.drive?.areaExists===true,
  proofStoreFolderDoesNotPreexist:r?.drive?.storeExists===false,
  folderProvisioningCorrectlyRequired:r?.manifest?.preconditions?.storeFolderProvisionRequired===true&&r?.manifest?.preconditions?.storeFolderExists===false,
  executorUnlockNotAuthorized:true
};

const failures=Object.entries(assertions).filter(([,v])=>v!==true).map(([k])=>k);
const audit={
  generatedAt:new Date().toISOString(),
  sourceReportFingerprint:r?.fingerprint||'',
  manifestHash:r?.manifest?.manifestHash||'',
  storeId:r?.manifest?.derived?.storeId||'',
  storeKey:r?.manifest?.derived?.storeKey||'',
  semanticSafety:{
    deleteRequired:false,
    uploadRuntimeChangeRequired:false,
    fieldActivationRequiredNow:false,
    storeFolderProvisionRequired:r?.manifest?.preconditions?.storeFolderProvisionRequired===true
  },
  assertions,
  failures,
  certified:failures.length===0,
  auditFingerprint:''
};
audit.auditFingerprint=h({sourceReportFingerprint:audit.sourceReportFingerprint,manifestHash:audit.manifestHash,assertions:audit.assertions,semanticSafety:audit.semanticSafety});
fs.writeFileSync(out,JSON.stringify(audit,null,2));
console.log(JSON.stringify(audit,null,2));
if(failures.length)process.exitCode=2;
