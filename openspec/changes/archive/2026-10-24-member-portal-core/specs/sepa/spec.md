## ADDED Requirements

### Requirement: Mandate amendment after an IBAN change
The system SHALL keep the mandate when an accepted IBAN change replaces the debtor account and mark the next direct debit with the amendment indicator: with the original account when the bank stays the same, otherwise with original debtor agent `SMNDA`.

#### Scenario: New bank
- **WHEN** a member's accepted IBAN change moves the account to another bank and the next debit run is generated
- **THEN** that member's transaction carries `AmdmntInd` true and `OrgnlDbtrAgt` `SMNDA`, and later runs do not
