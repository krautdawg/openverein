-- Invoices get a closing text; the club keeps default cover and closing texts with placeholders, filled at issue.
alter table invoice add column closing_text text check (char_length(closing_text) <= 2000);
alter table organization add column invoice_cover_template text check (char_length(invoice_cover_template) <= 2000);
alter table organization add column invoice_closing_template text check (char_length(invoice_closing_template) <= 2000);

-- The closing text is frozen at issue like the cover text.
create or replace function ov_invoice_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'issued invoice % cannot be deleted', old.number using errcode = 'P0001'; end if;
    return old;
  end if;
  if old.status <> 'draft' then
    if (new.number, new.kind, new.recipient_person_id, new.member_id, new.recipient, new.issue_date, new.due_date, new.total_cents, new.cover_text, new.closing_text, new.cancels_invoice_id, new.fee_run_id)
       is distinct from
       (old.number, old.kind, old.recipient_person_id, old.member_id, old.recipient, old.issue_date, old.due_date, old.total_cents, old.cover_text, old.closing_text, old.cancels_invoice_id, old.fee_run_id) then
      raise exception 'issued invoice % is immutable; use a cancellation document', old.number using errcode = 'P0001';
    end if;
    if (new.organization_id, new.created_by, new.issued_at) is distinct from (old.organization_id, old.created_by, old.issued_at) then
      raise exception 'issued invoice % is immutable', old.number using errcode = 'P0001';
    end if;
    if (old.pdf is not null and new.pdf is distinct from old.pdf) or (old.pdf_sha256 is not null and new.pdf_sha256 is distinct from old.pdf_sha256) then
      raise exception 'stored PDF of invoice % cannot change', old.number using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
