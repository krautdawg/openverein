-- Work-hour rules by year: settling an old year uses that year's rule, not today's. A rule applies from its year
-- until a later one. The current club-wide rule becomes the rule from 2000 on, so nothing changes for existing data.
create table work_hour_rule (
  organization_id uuid not null references organization(id),
  from_year smallint not null check (from_year between 2000 and 2100),
  required numeric(5, 1) check (required > 0 and required <= 200),
  rate_cents bigint check (rate_cents >= 0 and rate_cents <= 100000),
  age_from smallint check (age_from between 0 and 120),
  age_to smallint check (age_to between 0 and 120),
  primary key (organization_id, from_year)
);
insert into work_hour_rule (organization_id, from_year, required, rate_cents, age_from, age_to)
  select id, 2000, work_hours_required, work_hours_rate_cents, work_hours_age_from, work_hours_age_to from organization
  where work_hours_required is not null or work_hours_rate_cents is not null;

-- What a settlement was computed from, frozen with it.
alter table work_hour_settlement
  add column required numeric(5, 1),
  add column done numeric(7, 2),
  add column missing numeric(7, 2),
  add column rate_cents bigint;
