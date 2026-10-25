## Why

P2.7: clubs invoice the same things again and again (kit, hall hire, course fees) and retype text, price and VAT each time.

## What Changes

- Article catalogue (name, gross price, VAT rate 0/7/19 %), names unique among active articles; archived instead of deleted.
- Rechnungen → Artikel to manage it; "Artikel einfügen" in the invoice editor copies text, price and VAT into a line (an empty first line is replaced). Issued invoices never change when an article does.
- Readers with invoice access see the catalogue; club-wide invoice writers change it.

## Capabilities

### Modified Capabilities

- `fees-and-invoices`: article catalogue. Offers / quotes with their own number range and event price groups come later.

## Impact

Migration `0033_articles.sql`. Decision recorded: UI texts stay inline German until the English UI.
