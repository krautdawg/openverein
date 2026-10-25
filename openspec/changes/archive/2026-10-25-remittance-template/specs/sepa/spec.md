## ADDED Requirements

### Requirement: Remittance text template
The system SHALL build each debit's remittance text from the organisation's template and refuse templates with unknown placeholders.

#### Scenario: Member number in the remittance text
- **WHEN** the template is "Beitrag {{mitgliedsnummer}} {{rechnungsnummer}}" and a debit run is generated
- **THEN** each debit's Ustrd reads "Beitrag <member number> <invoice number>"
