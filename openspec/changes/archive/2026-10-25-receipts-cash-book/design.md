## Decisions

- **Posting at payment.** A receipt changes nothing in the EÜR until it is paid; paying posts expense lines against the money account on the payment date, under the journal lock with the cash check.
- **Own upload route.** Treasurers often have no documents rights; receipts upload through `/receipts/files` under the ledger grant, stored with voucher retention outside any folder.
- **Frozen once paid.** A trigger refuses changes to amounts, supplier, number, date, file and lines of a paid receipt; corrections are void (reversal) and a new receipt.
