-- Donation receipts go out like invoices: by e-mail with the PDF, or collected as one letter batch.
alter table message drop constraint message_kind_check;
alter table message add constraint message_kind_check check (kind in ('free', 'invoices', 'donation_receipts'));
alter table delivery add column donation_receipt_id uuid references donation_receipt(id);
alter table mail_template drop constraint mail_template_key_check;
alter table mail_template add constraint mail_template_key_check check (key in ('invoice', 'dunning', 'invitation', 'login_code', 'change_decided', 'resignation_received', 'application_received', 'application_accepted', 'application_rejected', 'expense_decided', 'donation_receipt'));
