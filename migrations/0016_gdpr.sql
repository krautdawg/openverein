-- Slice 14: consents, legal hold, anonymisation, erasure log, retention review.

alter table person
  add column anonymised_at timestamptz,
  add column legal_hold_reason text check (length(legal_hold_reason) between 3 and 300);

alter table organization add column erase_after_months int not null default 24 check (erase_after_months between 1 and 240);

create table consent (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  person_id uuid not null references person(id),
  purpose text not null check (purpose in ('newsletter', 'photos', 'phone_list', 'other')),
  label text check (length(label) between 1 and 200),
  source text not null check (source in ('form', 'portal', 'paper', 'admin')),
  text_version text check (length(text_version) <= 100),
  granted_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  withdrawn_source text check (withdrawn_source in ('form', 'portal', 'paper', 'admin')),
  created_by uuid references app_user(id)
);
create index consent_person_idx on consent (person_id);
-- One live consent per person and purpose (other: per label).
create unique index consent_live on consent (person_id, purpose, coalesce(label, '')) where withdrawn_at is null;

-- Opaque ids only; a copy is appended to a file next to the stored files, so a restored older backup is erased again.
create table erasure_log (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  person_id uuid not null,
  at timestamptz not null default now()
);
