-- The debit's remittance text (Verwendungszweck) comes from a template; the default keeps the previous text.
alter table organization add column remittance_template text not null default 'Lastschrift {{rechnungsnummer}} {{verein}}' check (char_length(remittance_template) between 1 and 140);
