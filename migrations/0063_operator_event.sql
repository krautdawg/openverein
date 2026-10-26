-- Operator actions on managed hosting (export handover, club deletion). Global and append-only: no foreign key to
-- organization, so the record outlives the club it describes.
create table operator_event (
  id uuid primary key default uuidv7(),
  at timestamptz not null default now(),
  action text not null check (action in ('tenant.exported', 'tenant.purged')),
  organization_id uuid not null,
  hostname text,
  detail jsonb
);
create index operator_event_org_idx on operator_event (organization_id);
create trigger operator_event_append_only before update or delete on operator_event for each row execute function ov_reject_change();
