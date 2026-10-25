-- In-kind donations (Sachzuwendungen): value, description and origin as on the BMF template; never booked as money.
alter table donation
  add column kind text not null default 'money' check (kind in ('money', 'in_kind')),
  add column in_kind_description text check (length(in_kind_description) between 1 and 1000),
  add column in_kind_source text check (in_kind_source in ('business', 'private', 'unknown')),
  add column in_kind_valuation_docs boolean,
  add constraint donation_in_kind_complete check (
    (kind = 'in_kind') = (in_kind_description is not null and in_kind_source is not null and in_kind_valuation_docs is not null)
    and (kind = 'money' or (not waiver and journal_entry_id is null)));
