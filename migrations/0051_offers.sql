-- Offers (Angebote, spec P21): own number range, PDF stored at issue, no ledger effect; convertible into an invoice draft.
alter table organization add column offer_number_pattern text not null default 'A-{YYYY}-{seq:4}';

create table offer (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  member_id uuid not null references member(id),
  person_id uuid not null references person(id),
  number text,
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'declined', 'converted')),
  issue_date date,
  valid_until date,
  recipient jsonb,
  cover_text text check (char_length(cover_text) <= 2000),
  closing_text text check (char_length(closing_text) <= 2000),
  total_cents bigint not null default 0,
  pdf bytea,
  invoice_id uuid references invoice(id),
  created_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, number),
  check ((status = 'draft') = (number is null)),
  check ((status = 'converted') = (invoice_id is not null))
);
create index offer_org_idx on offer (organization_id, created_at desc);

create table offer_line (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  offer_id uuid not null references offer(id) on delete cascade,
  position int not null,
  text text not null check (char_length(text) between 1 and 500),
  quantity numeric(12, 2) not null check (quantity > 0),
  unit_cents bigint not null,
  total_cents bigint not null,
  tax_rate numeric(5, 2) not null default 0,
  unique (offer_id, position)
);

-- What was sent stays as sent: content of an issued offer is frozen.
create function ov_offer_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'issued offer % cannot be deleted', old.number using errcode = 'P0001'; end if;
    return old;
  end if;
  if old.status <> 'draft' and (new.number, new.member_id, new.person_id, new.issue_date, new.valid_until, new.recipient, new.cover_text, new.closing_text, new.total_cents)
     is distinct from (old.number, old.member_id, old.person_id, old.issue_date, old.valid_until, old.recipient, old.cover_text, old.closing_text, old.total_cents) then
    raise exception 'issued offer % is immutable', old.number using errcode = 'P0001';
  end if;
  if old.pdf is not null and new.pdf is distinct from old.pdf then raise exception 'stored PDF of offer % cannot change', old.number using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger offer_guard before update or delete on offer for each row execute function ov_offer_guard();

create function ov_offer_line_guard() returns trigger language plpgsql as $$
declare s text;
begin
  select status into s from offer where id = coalesce(new.offer_id, old.offer_id);
  if s is not null and s <> 'draft' then raise exception 'lines of an issued offer cannot change' using errcode = 'P0001'; end if;
  return coalesce(new, old);
end $$;
create trigger offer_line_guard before insert or update or delete on offer_line for each row execute function ov_offer_line_guard();
