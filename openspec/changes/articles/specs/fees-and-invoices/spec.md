## ADDED Requirements

### Requirement: Article catalogue
The system SHALL keep a catalogue of articles with gross price and VAT rate that can be picked into invoice lines, copying their values so later changes never alter existing invoices.

#### Scenario: Price change
- **WHEN** an article's price changes after it was used on an issued invoice
- **THEN** the issued invoice keeps the old price
