-- Long operations run as jobs: the request returns 202 at once, a worker does the work, the job tray shows progress.
create table job (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  kind text not null check (kind in ('full_export')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  progress smallint not null default 0 check (progress between 0 and 100),
  detail text,
  error text,
  result_file_id uuid references file(id) on delete set null,
  attempts smallint not null default 0,
  created_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz
);
-- One running job of a kind per club: a double click or a retried request does not start a second export.
create unique index job_one_active on job (organization_id, kind) where status in ('queued', 'running');
create index job_pending_idx on job (created_at) where status in ('queued', 'running');
create index job_user_idx on job (created_by, created_at desc);
