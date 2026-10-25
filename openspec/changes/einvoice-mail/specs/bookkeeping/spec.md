## ADDED Requirements

### Requirement: E-invoices are mailed with their XML
The system SHALL attach the stored XRechnung XML to the invoice mail and send it to the recipient's e-invoice address when that is an e-mail address.

#### Scenario: City with an e-invoice mailbox
- **WHEN** an issued XRechnung invoice to a city with e-invoice address rechnung@stadt.example is mailed
- **THEN** one mail goes to rechnung@stadt.example with the PDF and the XML attached
