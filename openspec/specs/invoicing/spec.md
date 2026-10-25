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

### Requirement: Offers
The system SHALL issue offers with their own number range and a stored PDF, keep issued offers unchanged, and convert an offer at most once into an invoice draft with the same lines, without any ledger effect of the offer itself.

#### Scenario: Convert an accepted offer
- **WHEN** an issued offer is accepted and converted
- **THEN** an invoice draft with the offer's lines exists, and a second conversion is refused

