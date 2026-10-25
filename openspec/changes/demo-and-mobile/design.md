## Decisions

- **Seed through the API.** The demo uses `app.inject` against the same routes as the UI, so every demo record passes the same validation, numbering and audit as real data, and the seed breaks loudly when a rule changes.
- **Deterministic data.** A seeded PRNG makes every reset produce the same club, which keeps screenshots and support answers stable.
- **Public-demo locks** live in the CSRF hook as one regex over write routes, so they cannot be forgotten per route.
- **Apps load the server URL.** Capacitor's `server.url` keeps one web bundle, cookies and CSRF unchanged, and lets a web release reach the apps without a store update.
