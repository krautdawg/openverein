## ADDED Requirements

### Requirement: Incoming e-invoices fill the receipt form
The system SHALL read uploaded XRechnung, UBL, CII and ZUGFeRD files and suggest supplier, number, dates and gross amounts per VAT rate for the receipt, while storing the file unchanged.

#### Scenario: ZUGFeRD PDF
- **WHEN** a ZUGFeRD PDF with an invoice of 238,00 € at 19 % is uploaded
- **THEN** the receipt form shows the supplier, the invoice number and one line of 238,00 € with 19 %
