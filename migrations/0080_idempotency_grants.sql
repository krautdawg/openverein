-- A replay hands back the stored answer only to the same rights it was made under (Codex review G17): the hash of
-- the actor's grants (roles, group scopes, restricted fields) at the original request.
alter table idempotency_key add column grants_hash text;
