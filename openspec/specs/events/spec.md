# events Specification

## Purpose
The events capability covers calendars, events and RSVPs with ICS feeds, recurring events, and paid events and courses with price groups, capacity and waitlist (B P01, P02, P03). It is the first post-MVP module: none of it is part of the MVP milestone, but it is scheduled before a club cancels easyVerein. Items that B rates "should" or "could" are marked as such in the requirement name.
## Requirements
### Requirement: Calendars with group visibility
The system SHALL support several calendars, each visible to selected groups, and SHALL show a member only events of calendars visible to one of their current groups.

#### Scenario: Hidden calendar
- **WHEN** a member who is not in "Vorstand" opens the calendar
- **THEN** events of the "Vorstand" calendar are not shown

### Requirement: Events
The system SHALL keep events with title, description, location (free text or room), start and end in the organisation's time zone, minimum and maximum participants, registration window and participation mode (closed, open, with companion, public sign-up).

#### Scenario: Registration window closed
- **WHEN** a member tries to register after the registration window ended
- **THEN** the registration is refused

### Requirement: RSVP states
The system SHALL track per participant the states `invited`, `yes`, `maybe`, `no`, `attended` and `not attended`.

#### Scenario: Attendance after the event
- **WHEN** a trainer marks a participant with RSVP `yes` as present after the event
- **THEN** the state becomes `attended`

### Requirement: Calendar views
The system SHALL show month, week, day and list views with a toggle for a birthday overlay that respects field restrictions on date of birth.

#### Scenario: Birthday overlay restricted
- **WHEN** a user without the date-of-birth right switches on the birthday overlay
- **THEN** no birthdays are shown

### Requirement: ICS feeds and import
The system SHALL publish personal and per-calendar ICS feeds addressed by secret tokens that can be rotated, and import external calendars from ICS.

#### Scenario: Token rotated
- **WHEN** a member rotates their feed token
- **THEN** the old feed URL stops working

### Requirement: Recurring events
The system SHALL define recurring events by RRULE with exceptions, edit "this", "this and following" or "all" occurrences, and attach RSVPs to single occurrences.

#### Scenario: Holiday exception
- **WHEN** a weekly training has an exception on 24 December
- **THEN** no occurrence exists on that date and other occurrences are unchanged

#### Scenario: Edit following
- **WHEN** a trainer moves "this and following" occurrences from 18:00 to 19:00 starting 1 March
- **THEN** earlier occurrences keep 18:00

### Requirement: Price groups with invoices
The system SHALL support price groups per event (for example member, non-member, child) and create an invoice through the invoicing capability when a participation is confirmed.

#### Scenario: Paid course
- **WHEN** a non-member's participation in a course with a 4500-cent non-member price is confirmed
- **THEN** an invoice for 4500 cents is issued to that person

### Requirement: Capacity and waitlist
The system SHALL enforce maximum capacity with an ordered waitlist and promote the first waiting person automatically, with a mail, when a place frees.

#### Scenario: Promotion
- **WHEN** a confirmed participant cancels in a full course
- **THEN** the first person on the waitlist is promoted and notified

### Requirement: Weekly participation cap (could)
The system SHALL optionally cap participations per member and week per group, using the highest, lowest or summed value when a member is in several groups.

#### Scenario: Cap reached
- **WHEN** a member with a cap of 2 per week registers for a third session that week
- **THEN** the registration is refused

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

