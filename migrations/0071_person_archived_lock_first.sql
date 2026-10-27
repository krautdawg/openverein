-- Lock the person row first, then read its status (0064 filtered before locking: an uncommitted archive was not
-- waited for). Now an insert waits for a running duplicate resolve and then sees "archived"; if the insert came
-- first, the resolve's FOR UPDATE waits for it and its check sees the new record.
create or replace function ov_person_not_archived() returns trigger language plpgsql as $$
declare pid uuid; s text;
begin
  execute format('select ($1).%I', tg_argv[0]) using new into pid;
  if pid is null then return new; end if;
  select status into s from person where id = pid for share;
  if s = 'archived' then
    raise exception 'person % is archived', pid using errcode = 'check_violation', constraint = 'person_archived';
  end if;
  return new;
end $$;
