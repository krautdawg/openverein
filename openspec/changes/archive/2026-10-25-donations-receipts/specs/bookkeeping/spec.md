## ADDED Requirements

### Requirement: Cancelled receipts free their donations
The system SHALL keep a cancelled donation receipt with its reason and stored PDF, and SHALL let its donations be put on a new receipt with a new number.

#### Scenario: Reissue after cancellation
- **WHEN** a receipt is cancelled with the reason "Name falsch geschrieben"
- **THEN** the receipt shows as cancelled and a new receipt for the same donation can be issued
