-- Webhooks: every audited change of a subscribed topic is queued in the same transaction (outbox on audit_event),
-- then posted with an HMAC signature and retried. Payloads carry ids only; receivers read details through the API.
create table webhook (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  url text not null check (url ~ '^https?://' and length(url) <= 500),
  secret_encrypted text not null,
  topics text[] not null check (cardinality(topics) between 1 and 20),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table webhook_delivery (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  webhook_id uuid not null references webhook(id) on delete cascade,
  event text not null,
  entity_type text not null,
  entity_id text,
  occurred_at timestamptz not null,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  attempts smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  response_status smallint,
  error text,
  sent_at timestamptz
);
create index webhook_delivery_due_idx on webhook_delivery (next_attempt_at) where status in ('queued', 'sending');
create index webhook_delivery_hook_idx on webhook_delivery (webhook_id, occurred_at desc);

-- Topic = the part of the action before the first dot (member.created → member).
create function ov_webhook_outbox() returns trigger language plpgsql as $$
begin
  insert into webhook_delivery (organization_id, webhook_id, event, entity_type, entity_id, occurred_at)
  select new.organization_id, w.id, new.action, new.entity_type, new.entity_id, new.at
  from webhook w
  where w.organization_id = new.organization_id and w.active and split_part(new.action, '.', 1) = any(w.topics);
  return new;
end $$;
create trigger audit_event_webhook after insert on audit_event for each row execute function ov_webhook_outbox();
