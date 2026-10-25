-- Slice 11: cash-basis bookkeeping (EÜR) on a balanced, append-only journal.

create table ledger_account (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  number text not null check (number ~ '^[0-9]{3,8}$'),
  name text not null check (length(name) between 1 and 120),
  kind text not null check (kind in ('money', 'income', 'expense', 'tax', 'transit', 'other')),
  default_sphere text not null default 'ideell' check (default_sphere in ('ideell', 'vermoegen', 'zweck', 'wirtschaft')),
  -- account number in the tax adviser's DATEV chart; the DATEV export refuses accounts without it
  datev_number text check (datev_number ~ '^[0-9]{4,9}$'),
  hidden boolean not null default false,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, number)
);

create table tax_rate (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  label text not null,
  rate_bp int not null check (rate_bp between 0 and 10000),
  valid_from date not null,
  valid_to date,
  output_account_id uuid references ledger_account(id),
  input_account_id uuid references ledger_account(id),
  check (valid_to is null or valid_to >= valid_from)
);

create table cost_center (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  code text not null check (code ~ '^[0-9A-Za-z-]{1,12}$'),
  name text not null,
  unique (organization_id, code)
);

create table ledger_setting (
  organization_id uuid primary key references organization(id),
  bank_account_id uuid references ledger_account(id),
  cash_account_id uuid references ledger_account(id),
  fee_account_id uuid references ledger_account(id),
  other_income_account_id uuid references ledger_account(id),
  dunning_account_id uuid references ledger_account(id),
  -- GoBD: nothing may be posted on or before this date
  lock_date date
);

alter table bank_account add column ledger_account_id uuid references ledger_account(id);

create table journal_entry (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  number int not null,
  entry_date date not null,
  text text not null check (length(text) between 1 and 300),
  source text not null check (source in ('manual', 'allocation', 'allocation_reversal', 'reversal', 'receipt', 'import')),
  source_id uuid,
  reverses_id uuid references journal_entry(id),
  created_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  unique (organization_id, number)
);
-- One posting per allocation and one reversal per allocation or entry, even when the sync runs twice.
create unique index journal_entry_source_once on journal_entry (source, source_id) where source in ('allocation', 'allocation_reversal');
create unique index journal_entry_reversed_once on journal_entry (reverses_id) where reverses_id is not null;
create index journal_entry_date_idx on journal_entry (organization_id, entry_date);

create table journal_line (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  entry_id uuid not null references journal_entry(id),
  account_id uuid not null references ledger_account(id),
  debit_cents bigint not null default 0 check (debit_cents >= 0),
  credit_cents bigint not null default 0 check (credit_cents >= 0),
  sphere text not null check (sphere in ('ideell', 'vermoegen', 'zweck', 'wirtschaft')),
  cost_center_id uuid references cost_center(id),
  tax_rate_id uuid references tax_rate(id),
  text text,
  check ((debit_cents = 0) <> (credit_cents = 0))
);
create index journal_line_entry_idx on journal_line (entry_id);
create index journal_line_account_idx on journal_line (account_id);

-- Posted is posted: entries and lines are append-only.
create function journal_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'journal entries are append-only; correct them with a reversal' using errcode = 'check_violation';
end $$;
create trigger journal_entry_append_only before update or delete on journal_entry for each row execute function journal_append_only();
create trigger journal_line_append_only before update or delete on journal_line for each row execute function journal_append_only();
create trigger journal_entry_no_truncate before truncate on journal_entry execute function journal_append_only();
create trigger journal_line_no_truncate before truncate on journal_line execute function journal_append_only();

-- Every entry balances and has at least two lines, checked when the transaction commits.
create function journal_balanced() returns trigger language plpgsql as $$
declare d bigint; c bigint; n int;
begin
  select coalesce(sum(debit_cents), 0), coalesce(sum(credit_cents), 0), count(*) into d, c, n from journal_line where entry_id = new.id;
  if n < 2 or d <> c or d = 0 then
    raise exception 'journal entry % is not balanced (debit %, credit %, % lines)', new.id, d, c, n using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger journal_entry_balanced after insert on journal_entry deferrable initially deferred for each row execute function journal_balanced();

-- GoBD lock: no entry and no payment on or before the lock date.
create function ledger_assert_open(org uuid, d date) returns void language plpgsql as $$
declare lock date;
begin
  -- for share: a lock change in flight (for update) and this insert wait for each other.
  select lock_date into lock from ledger_setting where organization_id = org for share;
  if lock is not null and d <= lock then
    raise exception 'period locked until %', lock using errcode = 'check_violation', constraint = 'ledger_period_locked';
  end if;
end $$;
create function journal_entry_lock_check() returns trigger language plpgsql as $$
begin perform ledger_assert_open(new.organization_id, new.entry_date); return new; end $$;
create function allocation_lock_check() returns trigger language plpgsql as $$
begin perform ledger_assert_open(new.organization_id, new.booked_on); return new; end $$;
create trigger journal_entry_lock before insert on journal_entry for each row execute function journal_entry_lock_check();
create trigger allocation_lock before insert on allocation for each row execute function allocation_lock_check();

-- A default chart and the German tax rates for a club (neutral numbers; the tax adviser maps them to DATEV).
create function ov_seed_ledger(org uuid) returns void language plpgsql as $$
declare bank uuid; cash uuid; fees uuid; other uuid; dun uuid; vin uuid; vout uuid;
begin
  if exists (select 1 from ledger_account where organization_id = org) then return; end if;
  insert into ledger_account (organization_id, number, name, kind, default_sphere) values
    (org, '1000', 'Kasse', 'money', 'ideell'),
    (org, '1100', 'Bank', 'money', 'ideell'),
    (org, '1360', 'Geldtransit', 'transit', 'ideell'),
    (org, '1570', 'Vorsteuer', 'tax', 'wirtschaft'),
    (org, '1770', 'Umsatzsteuer', 'tax', 'wirtschaft'),
    (org, '4000', 'Mitgliedsbeiträge', 'income', 'ideell'),
    (org, '4010', 'Aufnahmegebühren', 'income', 'ideell'),
    (org, '4100', 'Spenden', 'income', 'ideell'),
    (org, '4200', 'Zuschüsse', 'income', 'ideell'),
    (org, '4300', 'Kurs- und Teilnahmegebühren', 'income', 'zweck'),
    (org, '4400', 'Sonstige Einnahmen', 'income', 'ideell'),
    (org, '4410', 'Mahngebühren', 'income', 'ideell'),
    (org, '4500', 'Zinsen', 'income', 'vermoegen'),
    (org, '4600', 'Verkauf und Bewirtung', 'income', 'wirtschaft'),
    (org, '6000', 'Übungsleitung', 'expense', 'ideell'),
    (org, '6100', 'Sportbetrieb und Material', 'expense', 'ideell'),
    (org, '6200', 'Hallen- und Platzmiete', 'expense', 'ideell'),
    (org, '6300', 'Verbandsabgaben', 'expense', 'ideell'),
    (org, '6400', 'Versicherungen', 'expense', 'ideell'),
    (org, '6500', 'Verwaltung und Porto', 'expense', 'ideell'),
    (org, '6600', 'Kontoführung', 'expense', 'ideell'),
    (org, '6700', 'Veranstaltungen', 'expense', 'zweck'),
    (org, '6800', 'Wareneinkauf', 'expense', 'wirtschaft'),
    (org, '6900', 'Sonstige Ausgaben', 'expense', 'ideell');
  select id into cash from ledger_account where organization_id = org and number = '1000';
  select id into bank from ledger_account where organization_id = org and number = '1100';
  select id into fees from ledger_account where organization_id = org and number = '4000';
  select id into other from ledger_account where organization_id = org and number = '4400';
  select id into dun from ledger_account where organization_id = org and number = '4410';
  select id into vin from ledger_account where organization_id = org and number = '1570';
  select id into vout from ledger_account where organization_id = org and number = '1770';
  insert into ledger_setting (organization_id, bank_account_id, cash_account_id, fee_account_id, other_income_account_id, dunning_account_id) values (org, bank, cash, fees, other, dun) on conflict do nothing;
  insert into tax_rate (organization_id, label, rate_bp, valid_from, valid_to, output_account_id, input_account_id) values
    (org, 'ohne USt', 0, '1968-01-01', null, null, null),
    (org, '19 %', 1900, '2007-01-01', '2020-06-30', vout, vin),
    (org, '16 %', 1600, '2020-07-01', '2020-12-31', vout, vin),
    (org, '19 %', 1900, '2021-01-01', null, vout, vin),
    (org, '7 %', 700, '1983-07-01', '2020-06-30', vout, vin),
    (org, '5 %', 500, '2020-07-01', '2020-12-31', vout, vin),
    (org, '7 %', 700, '2021-01-01', null, vout, vin);
end $$;
select ov_seed_ledger(id) from organization;
