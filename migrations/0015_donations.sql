-- Slice 13: money donations and donation receipts (Zuwendungsbestätigungen) after the BMF template.

alter table organization
  add column exemption_kind text check (exemption_kind in ('freistellung', 'feststellung')),
  add column exemption_office text,
  add column exemption_tax_number text,
  add column exemption_date date,
  add column exemption_period text,
  add column exemption_purposes text,
  add column receipt_signer text;

alter table journal_entry drop constraint journal_entry_source_check;
alter table journal_entry add constraint journal_entry_source_check check (source in ('manual', 'allocation', 'allocation_reversal', 'reversal', 'receipt', 'import', 'donation'));

create table donation (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  person_id uuid not null references person(id),
  donated_on date not null,
  amount_cents bigint not null check (amount_cents > 0),
  -- Verzicht auf Erstattung von Aufwendungen
  waiver boolean not null default false,
  note text,
  journal_entry_id uuid references journal_entry(id),
  created_by uuid references app_user(id),
  created_at timestamptz not null default now()
);
create index donation_person_idx on donation (person_id, donated_on);

create table donation_receipt (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  number text not null,
  kind text not null check (kind in ('single', 'collective')),
  person_id uuid not null references person(id),
  issued_on date not null,
  total_cents bigint not null,
  template text not null,
  pdf bytea not null,
  sha256 text not null,
  status text not null default 'issued' check (status in ('issued', 'cancelled')),
  cancel_reason text,
  cancelled_at timestamptz,
  created_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  unique (organization_id, number)
);

create table donation_receipt_item (
  receipt_id uuid not null references donation_receipt(id),
  donation_id uuid not null references donation(id),
  -- false once the receipt is cancelled, so the donation can go on a new receipt
  live boolean not null default true,
  primary key (receipt_id, donation_id)
);
-- A donation is on at most one valid receipt.
create unique index donation_receipt_item_live on donation_receipt_item (donation_id) where live;

-- Issued receipts never change, apart from being cancelled once; they are never deleted.
create function donation_receipt_frozen() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or old.status = 'cancelled'
     or (to_jsonb(new) - array['status', 'cancel_reason', 'cancelled_at']) is distinct from (to_jsonb(old) - array['status', 'cancel_reason', 'cancelled_at']) then
    raise exception 'donation receipts are immutable; cancel and reissue' using errcode = 'check_violation', constraint = 'donation_receipt_frozen';
  end if;
  return new;
end $$;
create trigger donation_receipt_frozen before update or delete on donation_receipt for each row execute function donation_receipt_frozen();

-- Donations on a valid receipt cannot change.
create function donation_frozen() returns trigger language plpgsql as $$
begin
  if exists (select 1 from donation_receipt_item where donation_id = old.id and live) then
    raise exception 'donation is on a receipt' using errcode = 'check_violation', constraint = 'donation_on_receipt';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger donation_frozen before update or delete on donation for each row execute function donation_frozen();
