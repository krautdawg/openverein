-- Slice 1: persons, members, groups with dated membership, roles, grants, API tokens.
create extension if not exists btree_gist;
create extension if not exists pg_trgm;

alter table organization
  add column member_number_pattern text not null default '{seq:4}',
  add column notice_weeks int not null default 6 check (notice_weeks between 0 and 104),
  add column exit_at text not null default 'quarter_end' check (exit_at in ('any_day', 'month_end', 'quarter_end', 'half_year_end', 'year_end'));

-- Gapless per-organisation counters, locked with SELECT … FOR UPDATE inside the issuing transaction.
create table number_sequence (
  organization_id uuid not null references organization(id),
  kind text not null,
  year int not null default 0,
  next_value int not null default 1,
  primary key (organization_id, kind, year)
);

create table person (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  kind text not null default 'natural' check (kind in ('natural', 'organisation')),
  first_name text,
  last_name text,
  company_name text,
  birth_date date,
  email text,
  phone text,
  street text,
  postal_code text,
  city text,
  country text not null default 'DE',
  preferred_channel text not null default 'email' check (preferred_channel in ('email', 'letter', 'none')),
  note text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'natural' and last_name is not null) or (kind = 'organisation' and company_name is not null))
);
create index person_name_trgm on person using gin ((lower(coalesce(last_name, '') || ' ' || coalesce(first_name, '') || ' ' || coalesce(company_name, ''))) gin_trgm_ops);
create index person_org_idx on person (organization_id, status);

create table member (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  person_id uuid not null unique references person(id),
  membership_number text not null,
  status text not null check (status in ('applicant', 'future', 'active', 'resigned', 'former', 'rejected')),
  application_date date,
  join_date date,
  notice_date date,
  exit_date date,
  exit_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, membership_number),
  check (exit_date is null or join_date is null or exit_date >= join_date),
  check (notice_date is null or exit_date is not null),
  check (status in ('applicant', 'rejected') or join_date is not null)
);
-- Default lists hide former members.
create index member_live_idx on member (organization_id, status) where status in ('applicant', 'future', 'active', 'resigned');

create table club_group (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  name text not null check (length(name) between 1 and 120),
  short_code text not null check (length(short_code) between 1 and 20),
  kind text not null default 'segment' check (kind in ('division', 'segment', 'board', 'team')),
  color text not null default 'blau',
  parent_id uuid references club_group(id),
  visible_to_members boolean not null default true,
  in_application_form boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index club_group_code_key on club_group (organization_id, lower(short_code));

create table group_membership (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  member_id uuid not null references member(id),
  group_id uuid not null references club_group(id),
  valid_from date not null,
  valid_to date,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from),
  -- No overlapping spells of one member in one group.
  exclude using gist (member_id with =, group_id with =, daterange(valid_from, valid_to, '[]') with &&)
);
create index group_membership_group_idx on group_membership (group_id, valid_from);

create table role (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  builtin_key text,
  name text not null,
  permissions jsonb not null,
  restricted_fields text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (organization_id, name),
  unique (organization_id, builtin_key)
);

create function ov_role_builtin_immutable() returns trigger language plpgsql as $$
begin
  if old.builtin_key is not null then
    raise exception 'built-in role % cannot be changed', old.name using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger role_builtin_immutable before update or delete on role for each row execute function ov_role_builtin_immutable();

create table role_grant (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  user_id uuid not null references app_user(id) on delete cascade,
  role_id uuid not null references role(id),
  scope_group_ids uuid[],
  created_at timestamptz not null default now(),
  unique (user_id, role_id)
);

create table api_token (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  name text not null,
  prefix text not null,
  token_hash text not null unique,
  role_id uuid not null references role(id),
  scope_group_ids uuid[],
  created_by uuid references app_user(id),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table app_user
  add column invite_token_hash text unique,
  add column invite_expires_at timestamptz;

-- Built-in roles, created per organisation (also called from first-run setup).
create function ov_seed_builtin_roles(org uuid) returns void language sql as $$
  insert into role (organization_id, builtin_key, name, permissions, restricted_fields) values
  (org, 'admin', 'Admin',
    '{"members":"write","groups":"write","fees":"write","invoices":"write","sepa":"write","banking":"write","ledger":"write","donations":"write","communication":"write","documents":"write","events":"write","settings":"write","audit":"read","imports":"write","api":"write"}', '{}'),
  (org, 'treasurer', 'Kassenwart',
    '{"members":"read","groups":"read","fees":"write","invoices":"write","sepa":"write","banking":"write","ledger":"write","donations":"write","communication":"write","documents":"read","events":"read","settings":"read","audit":"read","imports":"write","api":"none"}', '{}'),
  (org, 'division_lead', 'Abteilungsleitung',
    '{"members":"write","groups":"read","fees":"read","invoices":"read","sepa":"none","banking":"none","ledger":"none","donations":"none","communication":"write","documents":"read","events":"write","settings":"none","audit":"none","imports":"none","api":"none"}', '{iban}'),
  (org, 'trainer', 'Trainer:in',
    '{"members":"read","groups":"read","fees":"none","invoices":"none","sepa":"none","banking":"none","ledger":"none","donations":"none","communication":"write","documents":"read","events":"write","settings":"none","audit":"none","imports":"none","api":"none"}', '{iban,note}'),
  (org, 'tax_adviser', 'Steuerberatung',
    '{"members":"read","groups":"none","fees":"read","invoices":"read","sepa":"read","banking":"read","ledger":"read","donations":"read","communication":"none","documents":"none","events":"none","settings":"none","audit":"none","imports":"read","api":"none"}', '{iban,note,birth_date,email,phone}'),
  (org, 'cash_auditor', 'Kassenprüfung',
    '{"members":"read","groups":"read","fees":"read","invoices":"read","sepa":"read","banking":"read","ledger":"read","donations":"read","communication":"none","documents":"read","events":"none","settings":"none","audit":"read","imports":"read","api":"none"}', '{note}')
  on conflict (organization_id, builtin_key) do nothing;
$$;

-- Existing installations: seed roles and make every existing user an admin (slice 0 had only admins).
select ov_seed_builtin_roles(id) from organization;
insert into role_grant (organization_id, user_id, role_id)
select u.organization_id, u.id, r.id from app_user u join role r on r.organization_id = u.organization_id and r.builtin_key = 'admin';
