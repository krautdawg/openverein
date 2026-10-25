## ADDED Requirements

### Requirement: E-invoice amount due equals the printed total
The system SHALL produce XRechnung files whose amount due equals the issued invoice's gross total, putting rounding differences between gross and net-plus-tax into the rounding amount.

#### Scenario: Rounding case
- **WHEN** a 19 % line of 10.01 € gross is issued as XRechnung
- **THEN** the file's amount due is 10.01 € and the KoSIT validator accepts it
