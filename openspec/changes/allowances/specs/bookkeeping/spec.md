## ADDED Requirements

### Requirement: Volunteer allowance limits
The system SHALL track Übungsleiter- and Ehrenamtspauschale payments per person and year together with declared use elsewhere, and warn when a payment exceeds the tax-free limit of that year.

#### Scenario: Over the limit
- **WHEN** a trainer with 1,000 € declared elsewhere receives 2,500 € in 2026
- **THEN** the rest shows 200 € over the 3,300 € limit and the payment response warns about it
