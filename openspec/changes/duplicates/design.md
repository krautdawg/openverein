## Decisions

- **Candidates first.** The self-join only pairs persons with a trigram name match (`%`), the same e-mail or a shared IBAN hash, so it stays small; scoring happens on those.
- **Archive, never merge.** Financial records stay with the person they were issued to; a duplicate that has them is refused with the list, and the admin archives the other one or cleans up by hand.
