## Why

Public bodies and many companies only accept e-invoices. Clubs invoice cities for hall use, sponsors and partner clubs. The bookkeeping spec asks for XRechnung for recipients that want it, blocked while mandatory fields are missing, validated with the KoSIT validator in CI.

## What Changes

- Club tax data: VAT ID, tax number, register number (BT-30), e-invoice contact name and phone, small-business flag (§ 19 UStG).
- Recipient settings on the person: format (none / XRechnung), Leitweg-ID or buyer reference, e-invoice address, VAT ID.
- At issue, for XRechnung recipients: CII XML (XRechnung 3.0, EN 16931) created once and stored with SHA-256 (append-only); issuing is refused with the list of missing fields.
- Gross invoice lines become net lines per VAT group (basis from the gross sum, tax from the basis, cent differences in the rounding amount BT-114), so the amount due equals the PDF total. 0 % lines are category E (not taxable, e.g. membership fees); small businesses use E with the § 19 note. Discount lines use a negative quantity (BR-27). Fee periods become billing periods. Direct debits carry mandate, creditor ID and the payer's IBAN.
- `GET /invoices/:id/xrechnung.xml`; invoice detail shows the download.
- CI: `npm run validate:xrechnung` generates sample invoices (mixed rates with rounding, small business, credit note, direct debit with discount, tax number only) and validates them with the official KoSIT validator 1.6.3 and the XRechnung 3.0.2 configuration (all ACCEPTABLE).
- Web: club settings section "Steuer und E-Rechnung", member sheet section "E-Rechnung".

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `bookkeeping`: ZUGFeRD (PDF/A-3 with embedded XML) and UBL come later; XRechnung CII only.

## Impact

Migration `0024_einvoice.sql`; CI needs Java (setup-java).
