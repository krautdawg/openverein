## ADDED Requirements

### Requirement: Signed webhooks from an outbox
The system SHALL queue a webhook delivery in the same transaction as every audited change of a subscribed topic, post it with an HMAC signature, and retry failed deliveries with backoff.

#### Scenario: Receiver down
- **WHEN** the receiver answers 500 to a member.created delivery
- **THEN** the delivery stays queued with the attempt counted, and the next attempt after the backoff is signed and marked delivered on 2xx
