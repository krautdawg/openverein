-- Slice 7b: public online application forms with spam protection, immutable submissions, board decisions.

alter table organization
  -- The bank has agreed in writing that mandates may be given online (without a signature on paper).
  add column electronic_mandates_agreed boolean not null default false,
  add column join_rule text not null default 'next_month_first' check (join_rule in ('application_date', 'acceptance_date', 'month_first', 'next_month_first'));

create table application_form (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  slug text not null check (slug ~ '^[a-z0-9-]{3,60}$'),
  title text not null check (length(title) between 1 and 120),
  intro text,
  group_ids uuid[] not null default '{}',
  fee_plan_ids uuid[] not null default '{}',
  ask_mandate boolean not null default true,
  consent_text text not null,
  consent_version int not null default 1,
  privacy_url text,
  allowed_origins text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (slug)
);

create table application (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  form_id uuid not null references application_form(id),
  payload jsonb not null,
  consent jsonb not null,
  ip_hash text,
  status text not null default 'new' check (status in ('new', 'accepted', 'rejected', 'spam')),
  reason text,
  member_id uuid references member(id),
  decided_by uuid references app_user(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index application_status_idx on application (organization_id, status, created_at desc);

-- What the applicant sent stays as sent; only the decision columns change.
create function application_payload_immutable() returns trigger language plpgsql as $$
begin
  if new.payload is distinct from old.payload or new.consent is distinct from old.consent or new.created_at is distinct from old.created_at or new.form_id is distinct from old.form_id then
    raise exception 'application payload is immutable' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger application_payload_immutable before update on application for each row execute function application_payload_immutable();

alter table mail_template drop constraint mail_template_key_check;
alter table mail_template add constraint mail_template_key_check check (key in ('invoice', 'dunning', 'invitation', 'login_code', 'change_decided', 'resignation_received', 'application_received', 'application_accepted', 'application_rejected'));
