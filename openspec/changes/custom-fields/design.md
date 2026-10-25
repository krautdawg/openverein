## Decisions

- **Values on the person, keyed by field id.** One jsonb column with a GIN index; renaming a label never touches values; keys stay stable for placeholders.
- **Sensitive = club-wide only.** Group-scoped roles (trainers) never see sensitive fields; mails never get them.
- **Required on create, not on import.** An import cannot know a club's required fields; the profile shows empty values for later completion.
