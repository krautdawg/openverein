-- Slice 6: content-addressed file store, folders with group access, versions, retention and legal hold.

create table folder (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  parent_id uuid references folder(id),
  name text not null check (length(name) between 1 and 100),
  -- null: same access as the parent (top level: everyone with documents access)
  group_ids uuid[],
  created_at timestamptz not null default now(),
  unique nulls not distinct (organization_id, parent_id, name)
);

create table file (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  folder_id uuid references folder(id),
  member_id uuid references member(id),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes >= 0),
  mime_type text not null,
  name text not null check (length(name) between 1 and 255),
  retention_class text not null default 'document' check (retention_class in ('document', 'voucher', 'temporary')),
  retain_until date,
  legal_hold boolean not null default false,
  previous_id uuid references file(id),
  superseded_at timestamptz,
  uploaded_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  check (folder_id is null or member_id is null)
);
create index file_folder_idx on file (folder_id) where superseded_at is null;
create index file_member_idx on file (member_id) where superseded_at is null;
create index file_sha_idx on file (sha256);
create unique index file_one_successor on file (previous_id) where previous_id is not null;
