-- A reduced participation fee for children up to an age (spec P03 price groups, age-based); both or neither.
alter table event add column child_price_cents bigint check (child_price_cents >= 0);
alter table event add column child_up_to_age int check (child_up_to_age between 0 and 25);
alter table event add constraint event_child_price_pair check ((child_price_cents is null) = (child_up_to_age is null));
