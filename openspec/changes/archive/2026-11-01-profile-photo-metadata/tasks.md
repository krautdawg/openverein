## 1. Photo metadata

- [x] 1.1 stripPhotoMetadata for JPEG (all scans, up to EOI), PNG and WebP (allowlists), keeping only the orientation
- [x] 1.2 Applied on upload and import; again on public serving with its own ETag
- [x] 1.3 Tests with real-encoder fixtures carrying a GPS location; they fail on the previous code
