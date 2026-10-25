## ADDED Requirements

### Requirement: Reduced fee for children
The system SHALL invoice a confirmed participant the event's reduced fee when their age on the event day is at most the event's age limit, and SHALL issue no invoice when that fee is zero.

#### Scenario: Child and adult
- **WHEN** a 12-year-old and an adult confirm an event of 30 € with 10 € for children up to 13
- **THEN** the child is invoiced 10 € and the adult 30 €
