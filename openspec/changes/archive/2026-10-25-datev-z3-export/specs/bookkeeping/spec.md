## ADDED Requirements

### Requirement: DATEV rows with explicit tax lines
The system SHALL export each journal entry as DATEV rows of one account against one counter-account whose amounts add up to the entry, without BU keys, with tax lines as separate postings to the mapped tax accounts.

#### Scenario: Expense at 19 %
- **WHEN** an expense of 119 € with 19 % VAT is exported
- **THEN** the batch contains one row of 100 € to the expense account and one row of 19 € to the input-tax account, both against the bank account
