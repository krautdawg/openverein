## Why

Roadmap S23 asks for a permission attack-test suite in CI. The per-module tests check the routes their slice added; nothing checked that a route added later does not leak another division's data or an IBAN.

## What Changes

- `tests/attacks.test.ts` reads every route from the OpenAPI document and calls it as a scoped division lead, a trainer and the tax adviser, with the ids of an out-of-scope member, their person, mandate, invoice and group (and list routes filtered by them). No response may contain the outside member's name, e-mail or IBAN, nor any IBAN for roles without the IBAN field.
- Every PATCH, PUT, DELETE and POST route with an id is called by the division lead with out-of-scope ids; none may succeed.
- Search does not match IBAN fragments.
- A sanity case proves the scanner finds the data as admin.
- CI: `npm audit --omit=dev --audit-level=high`.

## Capabilities

### Modified Capabilities

- `platform`: permission attack suite runs in CI.

## Impact

Tests and CI only.
