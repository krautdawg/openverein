-- Slice 12: DATEV EXTF export with delta tracking, and the tax-audit (Z3) package.

alter table ledger_setting
  add column datev_consultant int check (datev_consultant between 1001 and 9999999),
  add column datev_client int check (datev_client between 1 and 99999),
  add column datev_account_length int not null default 4 check (datev_account_length between 4 and 8),
  add column fiscal_year_start_month int not null default 1 check (fiscal_year_start_month between 1 and 12);

create table datev_export (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  mode text not null check (mode in ('delta', 'full')),
  period_from date not null,
  period_to date not null,
  entry_count int not null,
  file bytea not null,
  sha256 text not null,
  created_by uuid references app_user(id),
  created_at timestamptz not null default now()
);

-- Which entries an export contained; the journal itself stays untouched (append-only).
create table datev_export_entry (
  export_id uuid not null references datev_export(id),
  entry_id uuid not null references journal_entry(id),
  primary key (export_id, entry_id)
);
create index datev_export_entry_entry_idx on datev_export_entry (entry_id);
