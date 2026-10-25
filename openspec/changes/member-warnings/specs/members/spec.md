## ADDED Requirements

### Requirement: Payment and access warnings
The system SHALL warn on the member record about a missing payment method, direct debit without an active mandate, and an administration account with the member's e-mail address.

#### Scenario: Direct debit without mandate
- **WHEN** a member pays by direct debit and neither they nor their household payer have an active mandate
- **THEN** the member record shows "Zahlt per Lastschrift, aber es gibt kein gültiges Mandat."
