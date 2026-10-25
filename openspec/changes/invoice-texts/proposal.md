## Why

M8 (should): treasurers enter some prices net ("zzgl. USt"), and clubs want a greeting above the lines and a closing text below them, the same on every invoice including fee runs.

## What Changes

- A line can be entered net (`net: true`). It is stored gross, rounded to the cent, because gross is how the rest of the system works.
- Invoices get a closing text. The club keeps default cover and closing texts with placeholders: `{{vorname}}`, `{{name}}`, `{{mitgliedsnummer}}`, `{{rechnungsnummer}}`, `{{betrag}}`, `{{faellig}}`, `{{verein}}`.
- The texts are filled at issue and frozen by the immutability trigger. An invoice's own text wins over the default. Cancellations get no default text.
- The PDF prints the closing text below the payment block.

## Capabilities

### Modified Capabilities

- `invoicing`: net entry, closing text, default texts.

## Impact

Migration `0047_invoice_texts.sql` (columns, plus the guard function extended to `closing_text`).
