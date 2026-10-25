-- Full exports are stored in the file store (purpose 'export', temporary: kept 7 days).
alter table file drop constraint file_purpose_check;
alter table file add constraint file_purpose_check check (purpose in ('document', 'receipt', 'export'));
