## Why

Clubs need to reach members: notices, newsletters, invoices with their PDF, reminders. Slice 5 sends mail through the club's own SMTP relay with a queue, a delivery log and suppression.

## What Changes

- Composer: recipients from all current members, a group or a hand-picked list, with excluded members and reasons; placeholders from a fixed safe list; live preview for the first recipient; notice vs. newsletter.
- Queue and worker: one delivery per recipient, claimed with SKIP LOCKED, rate per minute from the club settings, retries for temporary errors, 5xx rejects mark the delivery bounced and suppress the address.
- Newsletters carry an unsubscribe link and List-Unsubscribe header; unsubscribing never blocks club notices or invoices.
- Invoice and dunning mail with the invoice PDF attached per recipient, from a list of invoices or a whole fee run; letter recipients and undeliverable ones are listed for printing.
- Templates: own templates plus editable system texts (invoice, dunning, invitation); invitations for new users are mailed.
- Settings: sender name, address, reply-to, rate, test mail with SPF and DMARC hints, unblock an address; manual "bounced" on a delivery.
- Member sheet lists the mails sent to that member.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `communication`: placeholder list and plain-text composer for the MVP.

## Impact

Migration `0007_communication.sql`; dependency `nodemailer` (maintained, no transitive deps). New env `PUBLIC_URL`. Deferred (docs/decisions.md): free attachments (with the documents slice), saved views as recipients, rich-text editor, relay bounce webhooks, sender per purpose, printed status and letter batches.
