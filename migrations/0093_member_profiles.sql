-- Public member profiles (change public-profiles): a profile per membership, edited in the portal, public only with
-- a type, the board's approval of this version and not hidden. The photo is a member file (purpose photo).
alter table organization add column profile_types jsonb not null default '[]';
alter table organization add constraint organization_profile_types_list check (jsonb_typeof(profile_types) = 'array');

alter table file drop constraint file_purpose_check;
alter table file add constraint file_purpose_check check (purpose in ('document', 'receipt', 'export', 'photo'));

create table member_profile (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization on delete cascade,
  member_id uuid not null unique references member on delete cascade,
  display_name text check (length(display_name) <= 80),
  bio text check (length(bio) <= 2000),
  place text check (length(place) <= 80),
  organisation text check (length(organisation) <= 120),
  photo_file_id uuid references file on delete set null,
  -- 'none' or a key of organization.profile_types
  type_key text not null default 'none' check (type_key ~ '^[a-z0-9_-]{1,40}$'),
  contact_visibility text not null default 'board' check (contact_visibility in ('board', 'members', 'public')),
  hidden boolean not null default false,
  -- approval of the current version; any change to public content clears it
  approved_at timestamptz,
  approved_by uuid references app_user on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index member_profile_queue on member_profile (organization_id) where approved_at is null and type_key <> 'none' and not hidden;

create table member_profile_link (
  id uuid primary key default uuidv7(),
  profile_id uuid not null references member_profile on delete cascade,
  label text not null check (length(label) between 1 and 60),
  url text not null check (length(url) <= 500 and url ~ '^https?://'),
  position int not null default 0
);
create index member_profile_link_profile on member_profile_link (profile_id, position);
