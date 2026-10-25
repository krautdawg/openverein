## Decisions

- **CII only.** One syntax, validated end to end; UBL and ZUGFeRD are additive.
- **Net from gross per VAT group.** BR-CO-17 needs tax = basis × rate; the gross sum stays the amount due, the difference goes into BT-114 (at most one cent per group).
- **Exempt 0 %.** Membership fees and other 0 % lines are category E with a reason; that needs a VAT ID or tax number, and BR-CO-26 additionally needs a VAT ID or register number, which the missing-field check names.
