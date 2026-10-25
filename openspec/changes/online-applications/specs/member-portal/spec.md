## ADDED Requirements

### Requirement: Fixed application blocks
The system SHALL build application forms from fixed blocks (personal data, address, contact, offered groups, offered fee plans, optional SEPA mandate, guardian section for applicants under 18, consent with privacy link) configured per form.

#### Scenario: Guardian for minors
- **WHEN** an applicant enters a birth date less than 18 years ago
- **THEN** the form asks for a guardian, refuses submission without one, and refuses a mandate whose account holder is the applicant
