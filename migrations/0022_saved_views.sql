-- Saved member list views: private, or shared with everyone holding a role.
create table saved_view (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  owner_id uuid not null references app_user(id),
  name text not null check (length(name) between 1 and 80),
  params text not null check (length(params) <= 2000),
  shared_role_id uuid references role(id) on delete set null,
  created_at timestamptz not null default now()
);
create index saved_view_org_idx on saved_view (organization_id);
