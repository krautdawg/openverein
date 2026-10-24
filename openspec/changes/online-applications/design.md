## Decisions

- **Fixed blocks instead of a form builder.** Personal data, address, contact, groups, fee plan, mandate, guardian (shown under 18), consent. Clubs choose groups, plans, mandate and texts; a drag-and-drop builder waits for real demand.
- **Signed timestamp token** instead of a captcha: the form carries `ts.HMAC(slug, ts)`; under 3 seconds or older than 24 hours counts as a bot, and the response looks the same, so bots learn nothing.
- **Guardian on the member record.** The member's person gets the guardian's e-mail as contact and a note with the name; the mandate's account holder is the guardian, so pain.008 names the guardian as debtor and never the minor.
- **Accept reuses the admin paths** (`insertMember`, `insertMandate`) inside one transaction, so numbering, audit and the one-active-mandate rule are the same as manual entry.
