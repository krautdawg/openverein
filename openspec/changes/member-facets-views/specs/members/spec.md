## ADDED Requirements

### Requirement: Views store list parameters only
The system SHALL store a saved view as the list's parameters and SHALL evaluate every list request under the viewer's own permissions, so a shared view shows each viewer only what they may see.

#### Scenario: Trainer opens a shared view
- **WHEN** a trainer limited to the tennis group opens a view shared with the trainer role that filters on open balances
- **THEN** the list contains only tennis members with open balances
