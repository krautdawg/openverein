-- Tax-free volunteer allowances (§ 3 Nr. 26 and 26a EStG): payments per person and year, and what the person
-- declared as already used elsewhere (the limits apply per person across all payers).
create table allowance_payment (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  person_id uuid not null references person(id),
  kind text not null check (kind in ('uebungsleiter', 'ehrenamt')),
  paid_on date not null,
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 10000000),
  text text not null check (length(text) between 1 and 200),
  created_by uuid references app_user(id),
  created_at timestamptz not null default now()
);
create index allowance_payment_person_idx on allowance_payment (organization_id, person_id, paid_on);

create table allowance_declaration (
  organization_id uuid not null references organization(id),
  person_id uuid not null references person(id),
  year smallint not null,
  kind text not null check (kind in ('uebungsleiter', 'ehrenamt')),
  other_cents bigint not null check (other_cents >= 0),
  declared_on date not null,
  primary key (person_id, year, kind)
);
