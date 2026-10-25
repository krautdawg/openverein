-- Slice 8: member import from CSV (easyVerein preset) with dry run, match keys and rollback.

create table import_run (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  kind text not null default 'members' check (kind in ('members')),
  file_name text,
  file_sha256 text not null,
  preset text,
  counts jsonb not null default '{}',
  created_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  rolled_back_at timestamptz
);

-- Rows created by an import carry its id, so the whole import can be undone while nothing depends on it.
alter table person add column import_run_id uuid references import_run(id);
alter table member add column import_run_id uuid references import_run(id);
alter table club_group add column import_run_id uuid references import_run(id);
alter table group_membership add column import_run_id uuid references import_run(id);
alter table sepa_mandate add column import_run_id uuid references import_run(id);
create index person_import_idx on person (import_run_id) where import_run_id is not null;
create index member_import_idx on member (import_run_id) where import_run_id is not null;
create index club_group_import_idx on club_group (import_run_id) where import_run_id is not null;
create index group_membership_import_idx on group_membership (import_run_id) where import_run_id is not null;
create index sepa_mandate_import_idx on sepa_mandate (import_run_id) where import_run_id is not null;
create index import_run_sha_idx on import_run (organization_id, file_sha256);
