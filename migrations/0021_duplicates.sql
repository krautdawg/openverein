-- "Not a duplicate" decisions, stored per unordered pair (smaller id first).
create table duplicate_dismissal (
  organization_id uuid not null references organization(id),
  person_a uuid not null references person(id),
  person_b uuid not null references person(id),
  dismissed_by uuid references app_user(id),
  dismissed_at timestamptz not null default now(),
  primary key (person_a, person_b),
  check (person_a < person_b)
);
