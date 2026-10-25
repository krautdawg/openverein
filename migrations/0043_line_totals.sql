-- Invoice line totals must equal quantity × unit price, rounded half away from zero (Codex review of #3).
-- NOT VALID: lines issued before are documents of record and stay as they are; every new line is checked.
alter table invoice_line add constraint invoice_line_total_exact check (total_cents = round(quantity * unit_cents)) not valid;
