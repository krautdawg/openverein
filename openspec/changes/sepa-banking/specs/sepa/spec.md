## ADDED Requirements

### Requirement: Pre-notification on the invoice
The system SHALL print the SEPA pre-notification on every invoice of a member paying by direct debit with an active mandate (amount, earliest collection date equal to the due date, mandate reference, creditor ID), freeze these values at issue, and SHALL refuse to put an invoice into a collection run whose collection date is before the invoice's due date.

#### Scenario: Collection before due date
- **WHEN** a treasurer creates a run on 2 November for an invoice due on 15 November
- **THEN** the run is refused with a message about the pre-notification

### Requirement: Automatic matching order
The system SHALL match imported transactions automatically only in these cases, in this order: end-to-end ID of an open collection item with the same amount (settle), end-to-end ID of a collected item on a debit (return debit), a credit equal to the control sum of a downloaded or submitted file within ten days of its collection date while all its items are open (settle the file), and exactly one invoice number in the remittance text with the exact open amount (allocate); everything else SHALL only be suggested.

#### Scenario: Partial payment is only suggested
- **WHEN** a transfer of 2000 cents mentions an invoice with 5000 cents open
- **THEN** the transaction stays in the inbox with that invoice as a suggestion and nothing is booked
