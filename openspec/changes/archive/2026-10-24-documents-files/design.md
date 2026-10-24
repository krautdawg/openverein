## Decisions

- **Local volume, write-then-rename.** Blobs live at `FILES_DIR/ab/<sha256>`; a temp file is renamed into place so readers never see half a file. Re-uploading existing bytes refreshes the mtime so the sweep cannot race an upload.
- **Delete after commit by sweeping.** Rows go in the transaction; bytes go in the hourly sweep when unreferenced and older than an hour. No outbox table needed.
- **Raw bytes, not multipart.** `application/octet-stream` is not a CORS-simple type, so the CSRF guard allows it only on the upload routes without weakening the JSON rule elsewhere. File name and retention travel in the query string, the type in `X-File-Type`.
- **Safe downloads.** Only PDFs and raster images render inline; everything else is an attachment with `nosniff` and a sandbox CSP.
- **Invoice PDFs stay on the invoice row** (already immutable with their hash since slice 2).
