-- A contact entry only points at a file: deleting the file (or its expiry) must not fail on someone's private note.
alter table contact_log drop constraint contact_log_file_id_fkey;
alter table contact_log add constraint contact_log_file_id_fkey foreign key (file_id) references file(id) on delete set null;
