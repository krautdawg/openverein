-- Events imported from an ICS file remember their UID, so importing the same file again adds nothing twice.
alter table event add column import_uid text check (char_length(import_uid) <= 255);
create unique index event_import_uid on event (calendar_id, import_uid) where import_uid is not null;
