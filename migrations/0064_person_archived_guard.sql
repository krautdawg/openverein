-- An archived person (a resolved duplicate) gets no new financial records. The share lock on the person row makes
-- this race-safe against the archiving transaction, which holds the row FOR UPDATE while it checks for such records.
create function ov_person_not_archived() returns trigger language plpgsql as $$
declare pid uuid;
begin
  execute format('select ($1).%I', tg_argv[0]) using new into pid;
  if pid is not null and exists (select 1 from person where id = pid and status = 'archived' for share) then
    raise exception 'person % is archived', pid using errcode = 'check_violation', constraint = 'person_archived';
  end if;
  return new;
end $$;
create trigger invoice_person_not_archived before insert on invoice for each row execute function ov_person_not_archived('recipient_person_id');
create trigger sepa_mandate_person_not_archived before insert on sepa_mandate for each row execute function ov_person_not_archived('person_id');
create trigger donation_person_not_archived before insert on donation for each row execute function ov_person_not_archived('person_id');
create trigger collection_item_person_not_archived before insert on collection_item for each row execute function ov_person_not_archived('person_id');
create trigger offer_person_not_archived before insert on offer for each row execute function ov_person_not_archived('person_id');
create trigger allowance_payment_person_not_archived before insert on allowance_payment for each row execute function ov_person_not_archived('person_id');
create trigger allowance_declaration_person_not_archived before insert on allowance_declaration for each row execute function ov_person_not_archived('person_id');
create trigger expense_claim_person_not_archived before insert on expense_claim for each row execute function ov_person_not_archived('person_id');
create trigger household_payer_not_archived before insert or update of payer_person_id on household for each row execute function ov_person_not_archived('payer_person_id');
