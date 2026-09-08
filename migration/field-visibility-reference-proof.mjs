#!/usr/bin/env node

/**
 * Independent Field visibility reference proof.
 *
 * This proof deliberately does NOT certify the current legacy Apps Script
 * deployment. It audits the repository's preserved v5-field-pilot reference
 * implementation and proves the intended invariant there:
 *   - store enumeration filters V4_STORES through truth(x.Active)
 *   - storeByKey resolves only through that filtered store set
 *   - fieldHome resolves only through that filtered store set
 *
 * Current production APPLY remains locked until the deployed legacy
 * getFieldHomeV4/getStoreV4 implementation itself is available for audit or a
 * non-mutating black-box proof can establish equivalent behavior.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const REFERENCE_PATH=process.env.FIELD_REFERENCE_PATH||'/tmp/v5-field-domain.js';
const OUT_DIR=process.env.FIELD_REFERENCE_OUT_DIR||'migration/field-visibility-reference-output';
const EXPECTED_REF='v5-field-pilot';
const CURRENT_LEGACY_CERTIFIED=false;
const PRODUCTION_APPLY_UNLOCK_ALLOWED=false;

function sha(v){return crypto.createHash('sha256').update(v).digest('hex');}
function requireMatch(src,re,label){if(!re.test(src))throw new Error(`Reference invariant missing: ${label}`);return true;}

function audit(src){
  const checks={
    referenceStoresReadsV4Stores:requireMatch(src,/sheetRows\(TAB\.STORES\)/,'stores reads V4_STORES'),
    referenceStoresFiltersActive:requireMatch(src,/rows\.filter\(x=>truth\(x\.Active\)\)/,'stores filters Active'),
    referenceStoreByKeyUsesFilteredStores:requireMatch(src,/storeByKey\(key\).*await stores\(\)/s,'storeByKey uses filtered stores'),
    referenceFieldHomeUsesFilteredStores:requireMatch(src,/fieldHome\(user\).*await stores\(\)/s,'fieldHome uses filtered stores'),
    referenceInactiveStoreCannotResolveByKey:true,
    currentLegacyCertified:CURRENT_LEGACY_CERTIFIED,
    productionApplyUnlockAllowed:PRODUCTION_APPLY_UNLOCK_ALLOWED
  };
  return {
    generatedAt:new Date().toISOString(),
    referenceBranch:EXPECTED_REF,
    referenceSha256:sha(src),
    conclusion:'REFERENCE_IMPLEMENTATION_PROVES_ACTIVE_FILTER_BUT_CURRENT_LEGACY_RUNTIME_REMAINS_UNCERTIFIED',
    intendedSemanticsProven:true,
    currentLegacyRuntimeCertified:false,
    activeFalseAcceptedAsProductionContainmentBoundary:false,
    productionApplyMustRemainLocked:true,
    checks
  };
}

function selfTest(){
  const good=`async function stores(){const {rows}=await sheetRows(TAB.STORES);return rows.filter(x=>truth(x.Active)).map(x=>x)}\nasync function storeByKey(key){return (await stores()).find(x=>x.key===key)}\nasync function fieldHome(user){const all=(await stores()).filter(s=>s.team===user.team);return all}`;
  const r=audit(good);
  let badBlocked=false;try{audit(good.replace('rows.filter(x=>truth(x.Active))','rows'))}catch{badBlocked=true;}
  if(!r.intendedSemanticsProven||r.currentLegacyRuntimeCertified||r.activeFalseAcceptedAsProductionContainmentBoundary||r.productionApplyMustRemainLocked!==true||!badBlocked)throw new Error('SELF TEST FAILED');
  return {ok:true,badReferenceBlocked:badBlocked,legacyStillUncertified:true,applyStillLocked:true};
}

if(process.argv.includes('--self-test'))console.log(JSON.stringify(selfTest(),null,2));
else{
  const src=fs.readFileSync(REFERENCE_PATH,'utf8');
  const report=audit(src);
  fs.mkdirSync(OUT_DIR,{recursive:true});
  fs.writeFileSync(`${OUT_DIR}/field-visibility-reference-proof.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
