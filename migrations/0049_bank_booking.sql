-- Bank movements without an invoice can be booked straight to a ledger account (several at once).
alter table bank_transaction drop constraint bank_transaction_status_check;
alter table bank_transaction add constraint bank_transaction_status_check check (status in ('unmatched', 'matched', 'ignored', 'booked'));
alter table bank_transaction add column journal_entry_id uuid references journal_entry(id);
alter table bank_transaction add constraint bank_transaction_booked_entry check ((status = 'booked') = (journal_entry_id is not null));
