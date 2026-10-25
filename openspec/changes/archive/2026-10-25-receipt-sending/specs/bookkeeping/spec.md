## ADDED Requirements

### Requirement: Sending donation receipts
The system SHALL send issued donation receipts by e-mail with their stored PDF, once per receipt, and collect receipts for donors without e-mail or with a letter preference into one printable PDF.

#### Scenario: Donor without e-mail
- **WHEN** the year's receipts are sent and one donor has no e-mail address
- **THEN** that receipt is listed for printing and appears in the letter PDF
