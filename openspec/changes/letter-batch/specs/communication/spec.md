## ADDED Requirements

### Requirement: Letters as one duplex-ready PDF
The system SHALL merge the issued PDFs of invoices going out by letter into one PDF sorted by postal code, with every letter starting on a front page.

#### Scenario: Two letters, one page each
- **WHEN** two one-page invoices are printed as letters
- **THEN** the PDF has four pages, the second and fourth blank, and the lower postal code comes first
