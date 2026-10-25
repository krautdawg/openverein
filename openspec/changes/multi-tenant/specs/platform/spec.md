## ADDED Requirements

### Requirement: Managed hosting
With managed hosting switched on, the system SHALL create clubs only through the operator API, reach each club under its own host name, and keep every club's data, sign-ins and portal codes inside that club.

#### Scenario: Portal by host name
- **WHEN** a member of club B asks for a portal code under club A's host name
- **THEN** no code is issued in club A

#### Scenario: Access on another club's address
- **WHEN** the admin of club A signs in under club B's host name
- **THEN** the sign-in fails
