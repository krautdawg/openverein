# invoicing Specification

## Purpose
TBD - created by archiving change invoice-texts. Update Purpose after archive.
## Requirements
### Requirement: Invoice texts
The system SHALL fill the invoice's own cover and closing texts, or else the club's defaults, at issue and SHALL keep them unchanged afterwards.

#### Scenario: Default closing text
- **WHEN** the club's closing text is "Bitte zahle {{betrag}} bis {{faellig}}." and an invoice of 50 € due 01.07.2026 is issued
- **THEN** the invoice's closing text reads "Bitte zahle 50,00 € bis 01.07.2026." and a later change is refused by the database

### Requirement: Net prices
The system SHALL accept a line's unit price as net and store it gross, rounded to the cent.

#### Scenario: Net price at 19 %
- **WHEN** a line with a net unit price of 42,02 € and 19 % tax is saved
- **THEN** its unit price is 50,00 €

