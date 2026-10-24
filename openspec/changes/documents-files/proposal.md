## Why

Clubs keep statutes, minutes, forms and receipts somewhere. Slice 6 gives them one place: a content-addressed file store with folders, group access, versions and retention, plus files kept with a member record.

## What Changes

- File store on a local volume (`FILES_DIR`), addressed by SHA-256; identical bytes stored once; reads verify the hash.
- Folders with optional group restriction inherited by subfolders; scoped users see only folders of their groups.
- Upload as raw bytes (`application/octet-stream`, 20 MB), new versions keep the old ones downloadable.
- Retention classes: document, voucher (until 31 Dec of the 8th following year), temporary (deleted after 7 days); legal hold; deletion refused while either applies.
- Bytes are removed by an hourly sweep only when no row references them and they are older than an hour, so a rolled-back transaction never loses bytes.
- Files on a member record (members permissions apply).
- UI: documents page with breadcrumbs, drag and drop, file sheet (download, view, rename, move, retention, hold, versions, delete); member sheet "Dateien".

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `documents`: upload transport and member files.

## Impact

Migration `0008_documents.sql`; env `FILES_DIR`; Docker volume `/data`. No new dependencies. Deferred (docs/decisions.md): S3 backend, portal sharing (member portal slice), moving invoice PDFs from the invoice row into the store.
