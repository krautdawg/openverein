-- An anonymised person is final: no new personal data or financial records (a cancellation of an existing invoice
-- stays possible). The row is locked first, then read, so a concurrent anonymisation is waited for.
create or replace function ov_person_not_archived() returns trigger language plpgsql as $$
declare pid uuid; s text; anon timestamptz;
begin
  execute format('select ($1).%I', tg_argv[0]) using new into pid;
  if pid is null then return new; end if;
  select status, anonymised_at into s, anon from person where id = pid for share;
  if s = 'archived' then
    raise exception 'person % is archived', pid using errcode = 'check_violation', constraint = 'person_archived';
  end if;
  if anon is not null and not (tg_table_name = 'invoice' and to_jsonb(new) ->> 'kind' = 'cancellation') then
    raise exception 'person % is anonymised', pid using errcode = 'check_violation', constraint = 'person_anonymised';
  end if;
  return new;
end $$;
create trigger consent_person_not_archived before insert on consent for each row execute function ov_person_not_archived('person_id');

-- Donations are voided, never deleted (0062 returned OLD on DELETE, which let the delete through).
create or replace function donation_frozen() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'donations are voided, not deleted' using errcode = 'check_violation', constraint = 'donation_kept';
  end if;
  if new.note is null and to_jsonb(new) - 'note' = to_jsonb(old) - 'note' then
    return new;
  end if;
  if exists (select 1 from donation_receipt_item where donation_id = old.id and live) then
    raise exception 'donation is on a receipt' using errcode = 'check_violation', constraint = 'donation_on_receipt';
  end if;
  return new;
end $$;

-- A DATEV export is what was handed to the tax adviser: its bytes and its entries never change.
create trigger datev_export_append_only before update or delete on datev_export for each row execute function ov_reject_change();
create trigger datev_export_entry_append_only before update or delete on datev_export_entry for each row execute function ov_reject_change();
