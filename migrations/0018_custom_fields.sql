-- Custom fields on persons: definitions per club, values in person.custom keyed by field id.
create table custom_field (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label text not null check (length(label) between 1 and 100),
  type text not null check (type in ('text', 'multiline', 'number', 'date', 'checkbox', 'select', 'multiselect')),
  options text[] not null default '{}',
  required boolean not null default false,
  position int not null default 0,
  visible_to_member boolean not null default false,
  editable_by_member boolean not null default false,
  needs_approval boolean not null default true,
  sensitive boolean not null default false,
  gdpr_relevant boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, key)
);

alter table person add column custom jsonb not null default '{}';
create index person_custom_idx on person using gin (custom jsonb_path_ops);
