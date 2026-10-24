## ADDED Requirements

### Requirement: Wall-clock event times
The system SHALL store event start and end as wall-clock times in the organisation's time zone, keep the same local time for every occurrence of a series across daylight-saving changes, and publish ICS feeds with the organisation's TZID.

#### Scenario: Training across the clock change
- **WHEN** a weekly training at 18:00 has occurrences before and after the end of daylight saving time
- **THEN** every occurrence starts at 18:00 local time

### Requirement: Recurrence subset
The system SHALL create recurring events daily, weekly on chosen weekdays (optionally every n weeks) or monthly on the start day, ending by date or count; a monthly series on the 31st SHALL skip months without that day.

#### Scenario: Monthly on the 31st
- **WHEN** a monthly event starts on 31 January with four occurrences
- **THEN** they fall on 31 January, 31 March, 31 May and 31 July
