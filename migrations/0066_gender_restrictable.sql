-- Gender becomes a field roles can hide; the tax adviser sees only name, address and numbers (spec), so not gender.
-- Built-in roles are immutable for the app; this one-off correction lifts the guard for the migration only.
alter table role disable trigger role_builtin_immutable;
update role set restricted_fields = array_append(restricted_fields, 'gender') where builtin_key = 'tax_adviser' and not ('gender' = any (restricted_fields));
alter table role enable trigger role_builtin_immutable;

create or replace function ov_seed_builtin_roles(org uuid) returns void language sql as $$
  insert into role (organization_id, builtin_key, name, permissions, restricted_fields) values
  (org, 'admin', 'Admin',
    '{"members":"write","groups":"write","fees":"write","invoices":"write","sepa":"write","banking":"write","ledger":"write","donations":"write","communication":"write","documents":"write","events":"write","settings":"write","audit":"read","imports":"write","api":"write"}', '{}'),
  (org, 'treasurer', 'Kassenwart',
    '{"members":"read","groups":"read","fees":"write","invoices":"write","sepa":"write","banking":"write","ledger":"write","donations":"write","communication":"write","documents":"read","events":"read","settings":"read","audit":"read","imports":"write","api":"none"}', '{}'),
  (org, 'division_lead', 'Abteilungsleitung',
    '{"members":"write","groups":"read","fees":"read","invoices":"read","sepa":"none","banking":"none","ledger":"none","donations":"none","communication":"write","documents":"read","events":"write","settings":"none","audit":"none","imports":"none","api":"none"}', '{iban}'),
  (org, 'trainer', 'Trainer:in',
    '{"members":"read","groups":"read","fees":"none","invoices":"none","sepa":"none","banking":"none","ledger":"none","donations":"none","communication":"write","documents":"read","events":"write","settings":"none","audit":"none","imports":"none","api":"none"}', '{iban,note}'),
  (org, 'tax_adviser', 'Steuerberatung',
    '{"members":"read","groups":"none","fees":"read","invoices":"read","sepa":"read","banking":"read","ledger":"read","donations":"read","communication":"none","documents":"none","events":"none","settings":"none","audit":"none","imports":"read","api":"none"}', '{iban,note,birth_date,email,phone,gender}'),
  (org, 'cash_auditor', 'Kassenprüfung',
    '{"members":"read","groups":"read","fees":"read","invoices":"read","sepa":"read","banking":"read","ledger":"read","donations":"read","communication":"none","documents":"read","events":"none","settings":"none","audit":"read","imports":"read","api":"none"}', '{note}')
  on conflict (organization_id, builtin_key) do nothing;
$$;
