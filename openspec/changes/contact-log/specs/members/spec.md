## ADDED Requirements

### Requirement: Contact log
The system SHALL keep a contact log per person, show private entries only to their author, protect it like the member note, and delete it when the person is anonymised.

#### Scenario: Private entry
- **WHEN** a board member records a private entry
- **THEN** other users with access to the member do not see it

#### Scenario: Restricted role
- **WHEN** a role without access to member notes opens the contact log
- **THEN** the request is refused
