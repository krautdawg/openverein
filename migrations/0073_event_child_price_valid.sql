-- A child price is a reduction of the regular price: it needs one and is not higher (Codex review G15).
-- Existing rows: a child price above the regular price is capped at it; one without a regular price (it charged
-- nothing) is dropped.
update event set child_price_cents = price_cents where price_cents is not null and child_price_cents > price_cents;
update event set child_price_cents = null, child_up_to_age = null where price_cents is null and child_price_cents is not null;
alter table event add constraint event_child_price_valid check (child_price_cents is null or (price_cents is not null and child_price_cents <= price_cents));
