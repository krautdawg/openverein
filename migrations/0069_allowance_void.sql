-- Allowance payments are tax evidence: a wrong one is voided with a reason, never deleted.
alter table allowance_payment
  add column voided_at timestamptz,
  add column voided_by uuid references app_user(id),
  add column void_reason text check (char_length(void_reason) <= 300);
create function allowance_payment_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'allowance payments are voided, not deleted' using errcode = 'check_violation', constraint = 'allowance_payment_kept'; end if;
  -- Only voiding (once) changes a payment.
  if old.voided_at is not null or (to_jsonb(new) - 'voided_at' - 'voided_by' - 'void_reason') <> (to_jsonb(old) - 'voided_at' - 'voided_by' - 'void_reason') then
    raise exception 'allowance payment is fixed' using errcode = 'check_violation', constraint = 'allowance_payment_kept';
  end if;
  return new;
end $$;
create trigger allowance_payment_guard before update or delete on allowance_payment for each row execute function allowance_payment_guard();
