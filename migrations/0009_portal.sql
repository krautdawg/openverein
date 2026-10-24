-- Slice 7: member portal with e-mailed sign-in codes, change requests, resignation requests,
-- documents shared with members, and SEPA mandate amendments after an IBAN change.

create table login_code (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  email_hash text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  consumed_at timestamptz,
  issued_by uuid references app_user(id),
  created_at timestamptz not null default now()
);
create index login_code_email_idx on login_code (email_hash, created_at desc);

-- Members sign in by e-mail: the session belongs to the address and shows every membership registered under it
-- (a parent sees their children). Separate from admin sessions.
create table portal_session (
  token_hash text primary key,
  organization_id uuid not null references organization(id),
  email text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table change_request (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  member_id uuid not null references member(id),
  person_id uuid not null references person(id),
  -- address = street, postal code and city together (JSON), iban = IBAN and account holder (encrypted JSON)
  field text not null check (field in ('first_name', 'last_name', 'email', 'phone', 'address', 'iban', 'resignation')),
  old_value text,
  new_value text not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'denied', 'superseded', 'applied')),
  reason text,
  requested_by_email text not null,
  requested_at timestamptz not null default now(),
  decided_by uuid references app_user(id),
  decided_at timestamptz
);
create unique index change_request_one_pending on change_request (member_id, field) where status = 'pending';

alter table folder add column share_with_members boolean not null default false;

alter table sepa_mandate
  add column amended_from_iban_encrypted text,
  add column amendment_pending boolean not null default false;

alter table mail_template drop constraint mail_template_key_check;
alter table mail_template add constraint mail_template_key_check check (key in ('invoice', 'dunning', 'invitation', 'login_code', 'change_decided', 'resignation_received'));

-- The first debit after an IBAN change tells the bank about it; a released run hands that duty back.
alter table collection_item add column amended_from_iban_encrypted text;

-- Portal sign-in and request-code look persons up by address.
create index person_email_lower_idx on person (lower(email));
