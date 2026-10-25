-- Expense claims (Auslagen): members submit what they paid for the club, with the receipt, in the portal.
-- On approval the treasurer turns a claim into an open receipt; paying that receipt books it.
create table expense_claim (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  member_id uuid not null references member(id),
  person_id uuid not null references person(id),
  purpose text not null check (length(purpose) between 1 and 200),
  spent_on date not null,
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 10000000),
  account_holder text not null check (length(account_holder) between 1 and 70),
  iban_encrypted text not null,
  file_id uuid not null references file(id),
  status text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected')),
  receipt_id uuid references receipt(id),
  decided_by uuid references app_user(id),
  decided_at timestamptz,
  reject_reason text check (length(reject_reason) <= 500),
  created_at timestamptz not null default now(),
  constraint expense_claim_decided check ((status = 'submitted') = (decided_at is null) and (status = 'approved') = (receipt_id is not null))
);
create index expense_claim_org_idx on expense_claim (organization_id, status, created_at);
create unique index expense_claim_file_once on expense_claim (file_id);
