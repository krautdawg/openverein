-- Budget: planned net amount per income or expense account and year, compared with the books.
create table budget_line (
  organization_id uuid not null references organization(id),
  year smallint not null,
  account_id uuid not null references ledger_account(id),
  planned_cents bigint not null check (planned_cents >= 0 and planned_cents <= 100000000000),
  primary key (organization_id, year, account_id)
);
