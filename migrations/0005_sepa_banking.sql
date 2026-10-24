-- Slice 3: SEPA mandates, collection runs (pain.008 / pain.001), bank accounts, statement import,
-- matching and return debits. IBANs of members are stored encrypted with a blind index for lookups.

alter table organization
  add column creditor_id text check (creditor_id is null or creditor_id ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{3}[A-Z0-9]{1,28}$'),
  -- Days between the invoice (pre-notification) and the earliest collection date.
  add column prenotification_days int not null default 14 check (prenotification_days between 1 and 60);

create table bank_account (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  name text not null check (length(name) between 1 and 80),
  iban text not null,
  bic text,
  opening_balance_cents bigint not null default 0,
  opening_date date not null,
  min_lead_days int not null default 2 check (min_lead_days between 1 and 15),
  order_limit_cents bigint check (order_limit_cents > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, iban)
);

create table sepa_mandate (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  person_id uuid not null references person(id),
  reference text not null check (reference ~ '^[A-Za-z0-9/?:().,''+ -]{1,35}$'),
  signed_on date not null,
  account_holder text not null,
  iban_encrypted text not null,
  iban_hash text not null,
  iban_last4 text not null,
  bic text,
  type text not null default 'recurrent' check (type in ('recurrent', 'one_off')),
  status text not null default 'active' check (status in ('pending_evidence', 'active', 'revoked', 'expired')),
  first_collected boolean not null default false,
  last_collected_on date,
  revoked_on date,
  revoke_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, reference)
);
create index sepa_mandate_person_idx on sepa_mandate (person_id) where status = 'active';
create index sepa_mandate_iban_idx on sepa_mandate (iban_hash);
-- At most one active mandate per debtor person keeps "which mandate do we collect with" unambiguous.
create unique index sepa_mandate_one_active on sepa_mandate (person_id) where status = 'active';

create table collection_run (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  kind text not null check (kind in ('debit', 'transfer')),
  bank_account_id uuid not null references bank_account(id),
  collection_date date not null,
  status text not null default 'draft' check (status in ('draft', 'generated', 'downloaded', 'submitted', 'settled', 'released')),
  created_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  generated_at timestamptz,
  submitted_at timestamptz,
  released_at timestamptz,
  release_reason text
);

create table collection_file (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  run_id uuid not null references collection_run(id),
  position int not null,
  message_id text not null,
  schema text not null,
  sequence_type text,
  xml_encrypted text not null,
  sha256 text not null,
  item_count int not null,
  control_sum_cents bigint not null,
  first_downloaded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, message_id),
  unique (run_id, position)
);
-- Stored bytes are never regenerated or changed.
create trigger collection_file_append_only before update of xml_encrypted, sha256, message_id or delete on collection_file for each row execute function ov_reject_change();

create table collection_item (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  run_id uuid not null references collection_run(id),
  file_id uuid references collection_file(id),
  mandate_id uuid references sepa_mandate(id),
  person_id uuid not null references person(id),
  end_to_end_id text not null,
  amount_cents bigint not null check (amount_cents > 0),
  sequence_type text,
  status text not null default 'included' check (status in ('included', 'settled', 'returned', 'withdrawn')),
  created_at timestamptz not null default now(),
  unique (organization_id, end_to_end_id)
);

create table collection_item_invoice (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  item_id uuid not null references collection_item(id),
  invoice_id uuid not null references invoice(id),
  amount_cents bigint not null check (amount_cents > 0),
  live boolean not null default true
);
-- The double-debit guard: an invoice can be in only one live collection item.
create unique index collection_item_invoice_live on collection_item_invoice (invoice_id) where live;

create table bank_statement_import (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  bank_account_id uuid not null references bank_account(id),
  format text not null check (format in ('camt053', 'csv')),
  file_name text,
  file_sha256 text not null,
  period_from date,
  period_to date,
  opening_cents bigint,
  closing_cents bigint,
  transaction_count int not null default 0,
  raw_encrypted text,
  created_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  unique (bank_account_id, file_sha256)
);

create table bank_transaction (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  bank_account_id uuid not null references bank_account(id),
  import_id uuid references bank_statement_import(id),
  booking_date date not null,
  value_date date,
  amount_cents bigint not null,
  counterparty_name text,
  counterparty_iban_encrypted text,
  counterparty_iban_hash text,
  remittance text not null default '',
  end_to_end_id text,
  mandate_reference text,
  return_reason text,
  bank_reference text,
  dedupe_key text not null,
  status text not null default 'unmatched' check (status in ('unmatched', 'matched', 'ignored')),
  note text,
  created_at timestamptz not null default now(),
  unique (bank_account_id, dedupe_key)
);
create index bank_transaction_status_idx on bank_transaction (organization_id, status, booking_date);

alter table allocation add column bank_transaction_id uuid references bank_transaction(id);
alter table allocation add column collection_item_id uuid references collection_item(id);
create index allocation_tx_idx on allocation (bank_transaction_id);
create index allocation_item_idx on allocation (collection_item_id);
create index collection_item_run_idx on collection_item (run_id);
create index collection_item_file_idx on collection_item (file_id);
create index bank_transaction_import_idx on bank_transaction (import_id);

create table return_debit (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  bank_transaction_id uuid not null references bank_transaction(id),
  collection_item_id uuid not null unique references collection_item(id),
  reason_code text,
  fee_cents bigint not null default 0,
  created_by uuid references app_user(id),
  created_at timestamptz not null default now()
);
