# Data Preservation Contract

These are hard constraints for SMF v5.

## Never migrate existing operational data

v5 reads and writes the current backend in place. It does **not** create a replacement store table.

## Immutable identities

For an existing store:
- `Store ID` is permanent.
- `Store Key` is permanent.
- POE and photo relationships continue to use `Store Key`.

A store rename/address correction must not regenerate either identity.

## Existing POE

v5 must not clear or recreate `V4_POE`.

Updates are performed on the existing row for the same Environment + Store Key.

## Existing photos

v5 must not delete or trash an existing Drive file.

For MAIN photo replacement:
1. create/register the new file;
2. append new metadata;
3. mark prior active MAIN metadata inactive.

The previous physical Drive file remains.

## Existing folder hierarchy

When a store has photo history, v5 reuses `Folder ID` from `V4_PHOTOS` before attempting to create a store folder. This protects renamed stores from being split into a second folder.

## Inventory schema

Preserve:
- `Beginning JSON`
- `Installed JSON`
- `Take Home JSON`

`Take Home JSON` remains the schema-compatible storage field for **Remaining**.

## Finalization

Field users own final store outcomes:
- COMPLETED
- INCOMPLETE
- REFUSED
- CLOSED (displayed as STORE CLOSED)

Admin/Client endpoints must not finalize a field visit.

## Rollback

The current Apps Script v4.8.2 remains compatible with the same backend. If the v5 pilot is stopped, field users can return to v4.8.2 without a data migration.
