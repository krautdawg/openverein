-- Slice 2: fee plans, assignments, fee runs, assessments, invoices, payments, dunning.
-- Money is bigint cents. Issued invoices are immutable; corrections only by cancellation documents.

alter table organization
  add column street text,
  add column postal_code text,
  add column city text,
  add column email text,
  add column iban text,
  add column bic text,
  add column bank_name text,
  add column invoice_number_pattern text not null default 'R-{YYYY}-{seq:5}',
  add column cancellation_number_pattern text not null default 'S-{YYYY}-{seq:5}',
  add column payment_terms_days int not null default 14 check (payment_terms_days between 0 and 120),
  add column dunning_levels jsonb not null default '[{"level":1,"label":"Zahlungserinnerung","days":14,"feeCents":0},{"level":2,"label":"1. Mahnung","days":28,"feeCents":0},{"level":3,"label":"2. Mahnung","days":42,"feeCents":500}]';

alter table member
  add column payment_method text not null default 'none' check (payment_method in ('none', 'direct_debit', 'transfer', 'cash'));

create table fee_plan (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  name text not null check (length(name) between 1 and 120),
  line_text text not null default '{plan} {period_start}–{period_end}',
  status text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table fee_plan_version (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  fee_plan_id uuid not null references fee_plan(id),
  valid_from date not null,
  amount_cents bigint not null check (amount_cents >= 0),
  interval_months int check (interval_months between 1 and 60),
  anchor text not null default 'calendar' check (anchor in ('calendar', 'entry')),
  proration text not null default 'month' check (proration in ('none', 'month')),
  admission_fee_cents bigint not null default 0 check (admission_fee_cents >= 0),
  created_at timestamptz not null default now(),
  unique (fee_plan_id, valid_from)
);

create table fee_assignment (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  member_id uuid not null references member(id),
  fee_plan_id uuid not null references fee_plan(id),
  is_main boolean not null default true,
  valid_from date not null,
  valid_to date,
  first_period_start date,
  override_cents bigint check (override_cents >= 0),
  override_reason text,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from),
  check (override_cents is null or length(coalesce(override_reason, '')) > 0),
  exclude using gist (member_id with =, fee_plan_id with =, daterange(valid_from, valid_to, '[]') with &&),
  -- Exactly one main plan per member at any date.
  constraint fee_assignment_one_main exclude using gist (member_id with =, daterange(valid_from, valid_to, '[]') with &&) where (is_main)
);

create table fee_run (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  until date not null,
  issue_date date not null,
  due_date date not null,
  group_id uuid references club_group(id),
  status text not null default 'preview' check (status in ('preview', 'posted', 'cancelled')),
  preview jsonb not null,
  input_hash text not null,
  created_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  posted_at timestamptz,
  cancelled_at timestamptz
);

create table invoice (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  number text,
  kind text not null check (kind in ('membership', 'other', 'credit_note', 'cancellation', 'dunning_fee')),
  -- 'issued' is for documents that are not receivables or payables (cancellation documents).
  status text not null default 'draft' check (status in ('draft', 'issued', 'open', 'partially_paid', 'paid', 'cancelled', 'written_off')),
  recipient_person_id uuid not null references person(id),
  member_id uuid references member(id),
  recipient jsonb,
  issue_date date,
  due_date date,
  total_cents bigint not null default 0,
  paid_cents bigint not null default 0,
  cover_text text,
  cancels_invoice_id uuid references invoice(id),
  fee_run_id uuid references fee_run(id),
  pdf bytea,
  pdf_sha256 text,
  written_off_reason text,
  dunning_hold_until date,
  dunning_hold_reason text,
  created_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  issued_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (organization_id, number),
  check ((status = 'draft') = (number is null)),
  check (paid_cents >= 0)
);
create index invoice_open_idx on invoice (organization_id, due_date) where status in ('open', 'partially_paid');
create index invoice_recipient_idx on invoice (recipient_person_id);
-- A document can be cancelled only once.
create unique index invoice_cancels_once on invoice (cancels_invoice_id) where cancels_invoice_id is not null;

create table invoice_line (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  invoice_id uuid not null references invoice(id) on delete cascade,
  position int not null,
  text text not null check (length(text) between 1 and 500),
  quantity numeric(12, 2) not null default 1 check (quantity > 0),
  unit_cents bigint not null check (unit_cents >= 0),
  total_cents bigint not null,
  tax_rate numeric(5, 2) not null default 0 check (tax_rate in (0, 7, 19)),
  assessment_id uuid unique,
  unique (invoice_id, position)
);

create table assessment (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  member_id uuid not null references member(id),
  assignment_id uuid not null references fee_assignment(id),
  fee_run_id uuid references fee_run(id),
  charge_slot text not null,
  period_start date not null,
  period_end date not null,
  amount_cents bigint not null check (amount_cents >= 0),
  snapshot jsonb not null,
  status text not null default 'posted' check (status in ('posted', 'cancelled')),
  created_at timestamptz not null default now(),
  check (period_end >= period_start),
  -- The double-billing guard: no two live assessments of a member cover the same day in the same slot.
  constraint assessment_no_double_billing exclude using gist (
    organization_id with =, member_id with =, charge_slot with =, daterange(period_start, period_end, '[]') with &&
  ) where (status <> 'cancelled')
);
alter table invoice_line add constraint invoice_line_assessment_fkey foreign key (assessment_id) references assessment(id);

create table allocation (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  invoice_id uuid not null references invoice(id),
  amount_cents bigint not null check (amount_cents > 0),
  booked_on date not null,
  method text not null check (method in ('cash', 'transfer', 'direct_debit', 'other', 'write_off')),
  note text,
  status text not null default 'confirmed' check (status in ('confirmed', 'reversed')),
  created_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  reversed_at timestamptz
);
create index allocation_invoice_idx on allocation (invoice_id);

create table dunning_event (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  invoice_id uuid not null references invoice(id),
  level int not null,
  label text not null,
  fee_cents bigint not null default 0,
  fee_invoice_id uuid references invoice(id),
  created_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  unique (invoice_id, level)
);
create trigger dunning_event_append_only before update or delete on dunning_event for each row execute function ov_reject_change();

-- Issued invoices are immutable: only payment state, the stored PDF (once), write-off and dunning hold may change.
create function ov_invoice_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'issued invoice % cannot be deleted', old.number using errcode = 'P0001'; end if;
    return old;
  end if;
  if old.status <> 'draft' then
    if (new.number, new.kind, new.recipient_person_id, new.member_id, new.recipient, new.issue_date, new.due_date, new.total_cents, new.cover_text, new.cancels_invoice_id, new.fee_run_id)
       is distinct from
       (old.number, old.kind, old.recipient_person_id, old.member_id, old.recipient, old.issue_date, old.due_date, old.total_cents, old.cover_text, old.cancels_invoice_id, old.fee_run_id) then
      raise exception 'issued invoice % is immutable; use a cancellation document', old.number using errcode = 'P0001';
    end if;
    if old.pdf is not null and new.pdf is distinct from old.pdf then
      raise exception 'stored PDF of invoice % cannot change', old.number using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger invoice_guard before update or delete on invoice for each row execute function ov_invoice_guard();

create function ov_invoice_line_guard() returns trigger language plpgsql as $$
declare s text;
begin
  select status into s from invoice where id = coalesce(new.invoice_id, old.invoice_id);
  -- s is null while a draft invoice is being deleted (cascade); that is allowed.
  if s is not null and s <> 'draft' then
    raise exception 'lines of an issued invoice cannot change' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;
create trigger invoice_line_guard before insert or update or delete on invoice_line for each row execute function ov_invoice_line_guard();
