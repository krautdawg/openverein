-- A closed assembly is a legal record: the row itself is frozen too (not only its items and attendance), and the
-- child guard takes a share lock on the assembly, so a result written while it is being closed serialises with it.
create or replace function assembly_closed_guard() returns trigger language plpgsql as $$
declare closed timestamptz;
begin
  select a.closed_at into closed from assembly a where a.id = coalesce(new.assembly_id, old.assembly_id) for share;
  if closed is not null then raise exception 'assembly is closed' using errcode = 'check_violation', constraint = 'assembly_closed'; end if;
  return coalesce(new, old);
end $$;

create function assembly_row_closed_guard() returns trigger language plpgsql as $$
begin
  if old.closed_at is not null then raise exception 'assembly is closed' using errcode = 'check_violation', constraint = 'assembly_closed'; end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger assembly_row_closed before update or delete on assembly for each row execute function assembly_row_closed_guard();
