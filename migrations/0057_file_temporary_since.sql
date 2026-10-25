-- Temporary files expire seven days after they *became* temporary, not after their upload (Codex review of #5).
alter table file add column temporary_since timestamptz;
update file set temporary_since = created_at where retention_class = 'temporary';

create function ov_file_temporary_since() returns trigger language plpgsql as $$
begin
  if new.retention_class = 'temporary' then
    if tg_op = 'INSERT' or old.retention_class <> 'temporary' or old.temporary_since is null then
      new.temporary_since := coalesce(case when tg_op = 'UPDATE' and old.retention_class = 'temporary' then old.temporary_since end, now());
    end if;
  else
    new.temporary_since := null;
  end if;
  return new;
end $$;
create trigger file_temporary_since before insert or update of retention_class on file for each row execute function ov_file_temporary_since();
