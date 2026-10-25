-- Supplier receipts (Eingangsbelege): recorded open, posted to the journal when paid (cash basis).

-- Receipt files live in the file store but not in the document module.
alter table file add column purpose text not null default 'document' check (purpose in ('document', 'receipt'));
create table receipt (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  supplier text not null check (length(supplier) between 1 and 200),
  number text check (length(number) <= 100),
  receipt_date date not null,
  due_date date,
  status text not null default 'open' check (status in ('open', 'paid', 'void')),
  total_cents bigint not null check (total_cents > 0),
  file_id uuid references file(id),
  self_issued boolean not null default false,
  self_reason text check (length(self_reason) <= 500),
  paid_on date,
  money_account_id uuid references ledger_account(id),
  journal_entry_id uuid references journal_entry(id),
  void_reason text,
  note text,
  created_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index receipt_org_idx on receipt (organization_id, receipt_date);
create index receipt_supplier_number_idx on receipt (organization_id, lower(supplier), number);

create table receipt_line (
  id uuid primary key default uuidv7(),
  receipt_id uuid not null references receipt(id) on delete cascade,
  position int not null,
  text text check (length(text) <= 200),
  gross_cents bigint not null check (gross_cents > 0),
  account_id uuid not null references ledger_account(id),
  tax_rate_id uuid references tax_rate(id),
  sphere text check (sphere in ('ideell', 'vermoegen', 'zweck', 'wirtschaft')),
  cost_center_id uuid references cost_center(id)
);

-- A paid receipt is part of the books: its lines and amounts no longer change.
create function receipt_guard() returns trigger language plpgsql as $$
declare s text;
begin
  if tg_table_name = 'receipt' then
    if tg_op = 'DELETE' then raise exception 'receipts are voided, not deleted' using errcode = 'check_violation', constraint = 'receipt_frozen'; end if;
    -- Only paid -> void is allowed after payment, and the posting columns never change again.
    if old.status <> 'open' and (
         (new.total_cents, new.supplier, new.number, new.receipt_date, new.file_id, new.self_reason, new.paid_on, new.money_account_id, new.journal_entry_id)
           is distinct from (old.total_cents, old.supplier, old.number, old.receipt_date, old.file_id, old.self_reason, old.paid_on, old.money_account_id, old.journal_entry_id)
         or old.status = 'void' or (old.status = 'paid' and new.status not in ('paid', 'void'))) then
      raise exception 'receipt is posted' using errcode = 'check_violation', constraint = 'receipt_frozen';
    end if;
    return new;
  end if;
  -- Lines: both the old and the new receipt must still be open.
  if tg_op <> 'INSERT' then
    select status into s from receipt where id = old.receipt_id;
    if s is not null and s <> 'open' then raise exception 'receipt is posted' using errcode = 'check_violation', constraint = 'receipt_frozen'; end if;
  end if;
  if tg_op <> 'DELETE' then
    select status into s from receipt where id = new.receipt_id;
    if s is not null and s <> 'open' then raise exception 'receipt is posted' using errcode = 'check_violation', constraint = 'receipt_frozen'; end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger receipt_guard before update or delete on receipt for each row execute function receipt_guard();
create trigger receipt_line_guard before insert or update or delete on receipt_line for each row execute function receipt_guard();
