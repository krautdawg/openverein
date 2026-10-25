## ADDED Requirements

### Requirement: Offers
The system SHALL issue offers with their own number range and a stored PDF, keep issued offers unchanged, and convert an offer at most once into an invoice draft with the same lines, without any ledger effect of the offer itself.

#### Scenario: Convert an accepted offer
- **WHEN** an issued offer is accepted and converted
- **THEN** an invoice draft with the offer's lines exists, and a second conversion is refused
