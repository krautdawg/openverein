## Decisions

- **Only successes are stored.** Storing a 403 step-up or a 400 would make the natural retry fail; errors leave no trace, so they can be retried with the same key.
- **Scope.** Per club and actor (user id or `token:<id>`), so two users cannot collide or read each other's responses.
- **Hooks, not per-route code.** A `preHandler` claims the key with `insert … on conflict do nothing`; `onSend` stores 2xx responses or frees the key; `onError` frees it too.
