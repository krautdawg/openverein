-- Member polls (Umfragen): the board asks, current members answer in the portal, one answer per membership.
create table poll (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  question text not null check (length(question) between 1 and 300),
  description text check (length(description) <= 2000),
  options text[] not null check (cardinality(options) between 2 and 20),
  multiple boolean not null default false,
  -- null: all current members; otherwise members of this group
  group_id uuid references club_group(id),
  closes_on date not null,
  created_by uuid references app_user(id),
  created_at timestamptz not null default now()
);
create index poll_org_idx on poll (organization_id, closes_on desc);

create table poll_vote (
  poll_id uuid not null references poll(id) on delete cascade,
  member_id uuid not null references member(id),
  choices smallint[] not null check (cardinality(choices) >= 1),
  voted_at timestamptz not null default now(),
  primary key (poll_id, member_id)
);
