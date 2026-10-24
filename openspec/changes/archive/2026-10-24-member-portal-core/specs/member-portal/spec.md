## ADDED Requirements

### Requirement: Portal identity by e-mail address
The system SHALL sign members in per e-mail address and show every current membership whose person has that address, so a parent sees the memberships of children registered under the same address.

#### Scenario: Family under one address
- **WHEN** a parent and a child share an e-mail address and the parent signs in
- **THEN** the portal shows both memberships and the invoices addressed to either of them

### Requirement: Fixed field rules for change requests
The system SHALL apply phone number changes immediately and hold changes of name, e-mail address, postal address and IBAN for approval.

#### Scenario: Address waits
- **WHEN** a member changes their city in the portal
- **THEN** the member record keeps the old city until an admin accepts the request
