# Working on OpenVerein

- Behaviour is specified in `openspec/specs/`. Start every slice with `openspec new change <name>`; archive it after merge.
- The UI only calls the public `/api/v1` API. Every new UI action needs an API route with a zod schema (it appears in OpenAPI automatically).
- Money is integer cents. Legal dates are `date` columns kept as `YYYY-MM-DD` strings.
- Never edit a shipped migration; add a new numbered file in `migrations/`.
- Write audit events in the same transaction as the change (`src/server/audit.ts`).
- UI copy is German and uses "Du". Styling uses tokens from `src/web/styles/tokens.css` only.
- Commands: `npm run dev`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`.
