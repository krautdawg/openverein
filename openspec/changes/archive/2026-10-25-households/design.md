## Decisions

- **Assessments stay per member.** Each member's periods are assessed and cancelled exactly as before; only the invoice is shared. Cancelling the run cancels the household invoice and frees all its assessments.
- **Discount recomputed at posting.** Excluded preview lines change the discount, so posting recomputes it from the included lines.
- **Anchor member.** Invoices need a member for the number on the PDF and the payment method used by SEPA readiness; the payer's own membership is used, else the first member by number.
