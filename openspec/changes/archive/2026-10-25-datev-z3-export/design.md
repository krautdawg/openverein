## Decisions

- **Explicit tax lines, no BU keys.** The journal already splits net and tax onto mapped accounts; exporting those postings as they are avoids double taxation by DATEV's automatic accounts. The tax adviser maps the tax lines to non-automatic accounts.
- **Pairing.** Each entry becomes rows of one account against one counter-account by greedily pairing debit and credit lines; the sums are exact.
- **Delta by membership, not by flag.** `datev_export_entry` records which entries went out, because journal rows are append-only.
- **Z3 encoding.** CSV and index.xml in ISO-8859-1/Windows-1252, decimal comma, CRLF, as auditors' tools expect.
