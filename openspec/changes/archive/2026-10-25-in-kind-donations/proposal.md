## Why

P2.8: clubs receive goods (balls, kits, equipment) and must confirm them on the separate BMF template for Sachzuwendungen. OpenVerein only handled money donations.

## What Changes

- Donations can be money or goods. Goods carry the value, an exact description (age, condition, purchase price), the origin as stated by the donor (private assets, business assets at withdrawal value incl. VAT, no information despite asking) and whether valuation documents exist. Goods are never booked as money and cannot be a waiver.
- Receipts for goods use the BMF Sachzuwendung template (own wording, description box, origin and documents checkboxes, no membership-fee clause). Each in-kind donation gets its own receipt; mixing with money donations is refused; the annual run issues them separately.
- Donation form: Geld / Sache switch.

## Capabilities

### Modified Capabilities

- `bookkeeping`: in-kind donations. Booking goods into the books (Sachspende as income with an asset or expense) stays with the treasurer.

## Impact

Migration `0030_in_kind_donations.sql`.
