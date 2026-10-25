-- Each access arranges its own overview: section order and hidden sections (spec P22).
alter table app_user add column overview_layout jsonb not null default '{"order": [], "hidden": []}';
