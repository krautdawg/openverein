-- ETags come from updated_at at millisecond precision. Two writes in the same millisecond (or one that does not
-- set updated_at at all) would keep the version and let a stale If-Match through: every update moves it forward
-- by at least a millisecond. Named zz_ so it runs after the guard triggers, which see the update as sent.
create function ov_bump_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := greatest(new.updated_at, old.updated_at + interval '1 millisecond');
  return new;
end $$;
create trigger zz_bump_updated_at before update on person for each row execute function ov_bump_updated_at();
create trigger zz_bump_updated_at before update on member for each row execute function ov_bump_updated_at();
create trigger zz_bump_updated_at before update on organization for each row execute function ov_bump_updated_at();
create trigger zz_bump_updated_at before update on invoice for each row execute function ov_bump_updated_at();
