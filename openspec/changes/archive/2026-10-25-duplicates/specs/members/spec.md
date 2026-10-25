## ADDED Requirements

### Requirement: German spellings match in duplicate detection
The system SHALL treat ü/ue, ö/oe, ä/ae and ß/ss as equal when comparing names for duplicates.

#### Scenario: Müller and Mueller
- **WHEN** "Jürgen Müller" and "Juergen Mueller" share birth date, e-mail and address
- **THEN** the pair scores at least 90 %
