-- Article catalogue: recurring items (kit, hall hire, course fee) picked into invoice lines. Lines keep their own copy.
create table article (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  name text not null check (length(name) between 1 and 200),
  unit_cents bigint not null check (unit_cents >= 0 and unit_cents <= 100000000),
  tax_rate smallint not null default 0 check (tax_rate in (0, 7, 19)),
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index article_name_active on article (organization_id, lower(name)) where archived_at is null;
