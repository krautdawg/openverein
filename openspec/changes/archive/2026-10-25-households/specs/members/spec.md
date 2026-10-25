## ADDED Requirements

### Requirement: Household discount recomputed from included lines
The system SHALL compute a household's discount at posting from the lines that are actually billed, so excluding a preview line changes the discount accordingly.

#### Scenario: Excluded child fee
- **WHEN** the preview of a household with "50 % from the 2nd member" is posted with one child's fee excluded
- **THEN** the discount line covers only the remaining discounted fees
