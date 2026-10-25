## Why

M12 (should): the debit's remittance text (Verwendungszweck) was fixed to "Lastschrift <number> <club>". Clubs want the member number or the fee period there, so members recognise the debit on their statement.

## What Changes

- Organisation setting `remittanceTemplate` (1 to 140 characters) with the placeholders `{{rechnungsnummer}}`, `{{mitgliedsnummer}}`, `{{zeitraum}}` and `{{verein}}`. Unknown placeholders are refused.
- Debit items fill it from the invoice: the member number, and the fee period from the invoice's assessments. Empty placeholders collapse without leaving double spaces.
- Refund transfers keep their fixed text.

## Capabilities

### Modified Capabilities

- `sepa`: remittance text template.

## Impact

Migration `0045_remittance_template.sql`. The default keeps the previous text.
