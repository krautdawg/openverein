## Why

P03: holiday camps and courses usually charge children less. An event had only one fee.

## What Changes

- An event can carry a reduced fee for children up to an age (`childPriceCents` and `childUpToAge`, both or neither).
- The invoice on confirmation uses the age **on the event day**. A reduced fee of 0 € means no invoice.
- The invoice line says "(ermäßigt bis N Jahre)".
- The event form and detail show the reduced fee.

## Capabilities

### Modified Capabilities

- `events`: age-based price.

## Impact

Migration `0056_event_child_price.sql`.
