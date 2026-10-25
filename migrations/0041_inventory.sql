-- Inventory and lending: what the club owns, where it is, and who has it.
create table inventory_item (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  name text not null check (length(name) between 1 and 200),
  category text check (length(category) <= 80),
  location text check (length(location) <= 200),
  serial text check (length(serial) <= 100),
  quantity int not null default 1 check (quantity between 1 and 100000),
  value_cents bigint check (value_cents >= 0),
  note text check (length(note) <= 2000),
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create index inventory_item_org_idx on inventory_item (organization_id, name);

create table inventory_loan (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  item_id uuid not null references inventory_item(id),
  member_id uuid not null references member(id),
  quantity int not null default 1 check (quantity >= 1),
  lent_on date not null,
  due_on date,
  returned_on date,
  note text check (length(note) <= 500),
  lent_by uuid references app_user(id),
  check (returned_on is null or returned_on >= lent_on)
);
create index inventory_loan_open_idx on inventory_loan (organization_id) where returned_on is null;
