## ADDED Requirements

### Requirement: Printable lists and vCards
The system SHALL export the current filtered member list as a printable PDF and as vCard 4.0, leaving out fields the user's roles restrict.

#### Scenario: Tax adviser exports vCards
- **WHEN** a user whose role hides e-mail, phone and birth date exports vCards
- **THEN** the cards contain names and addresses but no e-mail, phone or birthday
