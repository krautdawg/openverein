-- Work hours (Arbeitsstunden): a club rule, logged hours per member, and a substitute fee per missing hour at year end.
alter table organization
  add column work_hours_required numeric(5, 1) check (work_hours_required > 0 and work_hours_required <= 200),
  add column work_hours_rate_cents bigint check (work_hours_rate_cents >= 0 and work_hours_rate_cents <= 100000),
  -- Only members aged within [from, to] on 1 January owe hours; null = no limit.
  add column work_hours_age_from smallint check (work_hours_age_from between 0 and 120),
  add column work_hours_age_to smallint check (work_hours_age_to between 0 and 120);

create table work_hour_entry (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  member_id uuid not null references member(id),
  worked_on date not null,
  hours numeric(5, 2) not null check (hours > 0 and hours <= 24),
  text text not null check (length(text) between 1 and 200),
  logged_by uuid references app_user(id),
  created_at timestamptz not null default now()
);
create index work_hour_entry_member_idx on work_hour_entry (member_id, worked_on);

-- One substitute-fee invoice per member and year: a second run does not bill twice.
create table work_hour_settlement (
  organization_id uuid not null references organization(id),
  member_id uuid not null references member(id),
  year smallint not null,
  invoice_id uuid not null references invoice(id),
  primary key (member_id, year)
);
