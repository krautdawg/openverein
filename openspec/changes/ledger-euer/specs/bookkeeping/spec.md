## ADDED Requirements

### Requirement: Neutral default chart with DATEV mapping
The system SHALL seed each club with a small neutral chart of accounts (money, transit, tax, income and expense accounts with a default sphere) and let every account carry the account number of the tax adviser's DATEV chart; the warning panel SHALL list used accounts without a DATEV number.

#### Scenario: Missing DATEV number
- **WHEN** an account with postings in the report range has no DATEV number
- **THEN** the EÜR warning panel shows how many accounts lack it and links to the chart

### Requirement: Payments post through an idempotent sync
The system SHALL post each confirmed payment allocation exactly once and each reversed allocation's posting exactly once as a reversal, before any journal read, report or lock change.

#### Scenario: Payment reversed
- **WHEN** a cash payment of 60 € is reversed
- **THEN** the journal shows the original posting and one reversal entry, and the original stays unchanged
