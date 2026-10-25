-- Idempotency keys on money writes: a repeated key returns the stored response instead of acting twice.
create table idempotency_key (
  organization_id uuid not null references organization(id),
  -- user id, or token:<id> for API tokens
  actor text not null,
  key text not null check (length(key) between 8 and 200),
  route text not null,
  request_hash text not null,
  status_code int,
  response text,
  content_type text,
  created_at timestamptz not null default now(),
  primary key (organization_id, actor, key)
);
create index idempotency_key_age on idempotency_key (created_at);
