-- Bulk actions on many members run as jobs: the frozen selection goes in params, the per-record outcome in result.
alter table job add column params jsonb not null default '{}', add column result jsonb;
alter table job drop constraint job_kind_check;
alter table job add constraint job_kind_check check (kind in ('full_export', 'member_bulk'));
-- Several bulk actions may run side by side; one at a time only for the export.
drop index job_one_active;
create unique index job_one_active on job (organization_id, kind) where status in ('queued', 'running') and kind = 'full_export';
