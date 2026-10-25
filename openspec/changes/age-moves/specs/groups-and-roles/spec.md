## ADDED Requirements

### Requirement: Age-based group change
The system SHALL move members of a group with an age rule to the target group when they reach the age (on the birthday or on 1 January), and show the upcoming moves before they happen.

#### Scenario: 18th birthday
- **WHEN** a member of "Jugend" (rule: 18, birthday, to "Erwachsene") turned 18 yesterday
- **THEN** the next run ends the Jugend membership yesterday, starts Erwachsene today, and logs the move
