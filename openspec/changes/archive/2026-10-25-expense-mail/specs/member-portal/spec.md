## ADDED Requirements

### Requirement: Expense decision mail
The system SHALL e-mail the member when their expense claim is approved or rejected, including the reason for a rejection.

#### Scenario: Rejected claim
- **WHEN** the treasurer rejects a claim with the reason "Beleg unleserlich"
- **THEN** the member receives an e-mail saying the claim is rejected with that reason
