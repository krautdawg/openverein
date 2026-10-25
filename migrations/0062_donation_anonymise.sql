-- Anonymising a donor clears the donation's free-text note; the receipt's amounts, dates and purpose stay frozen.
create or replace function donation_frozen() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.note is null and to_jsonb(new) - 'note' = to_jsonb(old) - 'note' then
    return new;
  end if;
  if exists (select 1 from donation_receipt_item where donation_id = old.id and live) then
    raise exception 'donation is on a receipt' using errcode = 'check_violation', constraint = 'donation_on_receipt';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
