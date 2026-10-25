## Why

Treasurers and board members look at the same slices again and again (youth under 18, open balances, members without a mandate). The members spec asks for facets and saved views shared with roles.

## What Changes

- New list facets (API and URL): payment method, age range (completed years today), join and exit date ranges (exit filters include former members), SEPA mandate active/none, household yes/no, open balance; combined with AND, together with status, group, search and the custom field filter.
- CSV export follows the same facets (same filter function).
- Saved views: name + the list's URL parameters; private, or shared with a role (only users with settings write may share); list shows own and role-shared views; delete own (or any with settings write). Views store parameters only, so the server applies the viewer's permissions to every list.
- Web: "Filter" side sheet with all facets, active facet count on the button, reset, save as view (optionally shared), view picker in the toolbar.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `members`: no column picker or per-user column widths yet; OR within one facet is limited to statuses.

## Impact

Migration `0022_saved_views.sql`.
