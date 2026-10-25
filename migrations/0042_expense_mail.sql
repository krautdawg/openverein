-- System text for the decision on an expense claim.
alter table mail_template drop constraint mail_template_key_check;
alter table mail_template add constraint mail_template_key_check check (key in ('invoice', 'dunning', 'invitation', 'login_code', 'change_decided', 'resignation_received', 'application_received', 'application_accepted', 'application_rejected', 'expense_decided'));
