## Decisions

- **Plain text in, simple HTML out.** The composer is a textarea; the worker escapes it and turns paragraphs and links into HTML. No template engine runs: placeholders are a fixed list replaced by string substitution, so nothing can execute or reach restricted fields.
- **Delivery rows are the queue.** No broker: the worker claims rows with `FOR UPDATE SKIP LOCKED`, marks them `sending`, and re-claims stuck rows after 10 minutes. Several app instances never send twice.
- **Suppression by hash.** Only an HMAC of the address is stored, so the list cannot leak addresses; unblocking takes the address again.
- **Mandatory vs. optional.** `notice` ignores unsubscribes and stops only for bounced addresses; `newsletter` honours both and the `none` channel preference.
- **Invoices by preferred channel.** Letter preference or no address → print list; one delivery per person and message, so several invoices for one person go out as separate messages.

## Risks / Trade-offs

- [Accepted by the relay ≠ delivered] → statuses say "Zugestellt an den Mailserver"; later bounces need a manual mark until webhooks exist.
