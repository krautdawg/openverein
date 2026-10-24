-- Slice 5: e-mail messages with per-recipient deliveries, suppression list, club sender settings.

alter table organization
  add column mail_from_name text,
  add column mail_from_address text,
  add column mail_reply_to text,
  add column mail_per_minute int not null default 60 check (mail_per_minute between 1 and 1000);

-- Set when the relay refuses login or the sender: the queue pauses instead of failing every recipient.
alter table organization add column mail_paused_reason text;

create table message (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  kind text not null default 'free' check (kind in ('free', 'invoices')),
  category text not null default 'notice' check (category in ('notice', 'newsletter')),
  subject text not null check (length(subject) between 1 and 200),
  body text not null check (length(body) <= 50000),
  recipient_filter jsonb not null,
  status text not null default 'sending' check (status in ('sending', 'sent')),
  created_by uuid references app_user(id),
  created_by_label text not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table delivery (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  message_id uuid not null references message(id),
  person_id uuid not null references person(id),
  member_id uuid references member(id),
  email text not null,
  invoice_id uuid references invoice(id),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'bounced', 'skipped')),
  attempts int not null default 0,
  claimed_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  error text,
  provider_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (message_id, person_id)
);
create index delivery_queue_idx on delivery (next_attempt_at) where status in ('queued', 'sending');
create index delivery_member_idx on delivery (member_id, created_at);
create index delivery_sent_idx on delivery (organization_id, sent_at) where status = 'sent';

create table suppression (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  email_hash text not null,
  reason text not null check (reason in ('unsubscribe', 'bounce', 'manual')),
  created_at timestamptz not null default now(),
  unique (organization_id, email_hash, reason)
);

-- Saved texts. System texts (key set) override the built-in defaults; free templates have no key.
create table mail_template (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  key text check (key in ('invoice', 'dunning', 'invitation')),
  name text not null check (length(name) between 1 and 100),
  subject text not null check (length(subject) between 1 and 200),
  body text not null check (length(body) <= 50000),
  category text not null default 'notice' check (category in ('notice', 'newsletter')),
  updated_at timestamptz not null default now(),
  unique (organization_id, key)
);
