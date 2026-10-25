## ADDED Requirements

### Requirement: Receipts post when paid
The system SHALL keep a recorded receipt out of the journal until it is paid and SHALL then post its lines on the payment date against the chosen money account; voiding a paid receipt SHALL post a reversal.

#### Scenario: Receipt paid later
- **WHEN** a receipt dated 1 April is paid by bank on 3 April
- **THEN** the journal shows the expense on 3 April and the receipt is frozen
