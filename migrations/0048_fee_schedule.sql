-- Optional monthly fee-run preview: on a set day the scheduler creates the preview for the user who set it up
-- (with that user's current rights) and mails them; posting still needs a click.
alter table organization
  add column fee_schedule_day int check (fee_schedule_day between 1 and 28),
  add column fee_schedule_lead_days int not null default 30 check (fee_schedule_lead_days between 0 and 366),
  add column fee_schedule_user_id uuid references app_user(id),
  add column fee_schedule_last_run date;
