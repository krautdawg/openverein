## ADDED Requirements

### Requirement: Greeting mails
The system SHALL send a greeting mail on a member's birthday or honoured membership anniversary only when the club switched it on, and at most once per person, kind and year.

#### Scenario: Run twice on the same day
- **WHEN** the greeting run happens twice on a member's 30th birthday with round-birthday greetings on
- **THEN** exactly one birthday mail is sent

### Requirement: Honours register
The system SHALL record awarded honours with title, date and decision and list them per year.

#### Scenario: Silver pin
- **WHEN** a member receives the "Silberne Ehrennadel" on 14.03.
- **THEN** the year's honours list shows it with the member
