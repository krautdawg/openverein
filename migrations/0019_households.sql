-- Households: one payer, one invoice per fee run, an effective-dated family discount.
create table household (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  name text not null check (length(name) between 1 and 100),
  payer_person_id uuid not null references person(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table household_rule (
  id uuid primary key default uuidv7(),
  household_id uuid not null references household(id) on delete cascade,
  valid_from date not null,
  kind text not null check (kind in ('none', 'percent', 'cap', 'children_free')),
  from_nth int check (from_nth between 2 and 20),
  percent_bp int check (percent_bp between 1 and 10000),
  cap_cents bigint check (cap_cents >= 0),
  created_at timestamptz not null default now(),
  unique (household_id, valid_from),
  check (kind = 'none' or (kind = 'percent' and from_nth is not null and percent_bp is not null) or (kind = 'cap' and cap_cents is not null) or (kind = 'children_free' and from_nth is not null))
);

alter table member add column household_id uuid references household(id);
create index member_household_idx on member (household_id) where household_id is not null;

-- Discount lines are the only invoice lines with a negative price.
alter table invoice_line add column discount boolean not null default false;
alter table invoice_line drop constraint invoice_line_unit_cents_check;
alter table invoice_line add constraint invoice_line_unit_cents_check check (unit_cents >= 0 or discount);
