-- Member sign-ins belong to an address (Codex second review of agent access): when a person's address changes or the
-- person is deleted (import rollback), the address's portal sessions and member tokens go too, unless another person
-- of the club still has that address. Replaces the update-only trigger of 0090.
create or replace function ov_member_tokens_follow_email() returns trigger language plpgsql as $$
begin
  if old.email is not null and (tg_op = 'DELETE' or lower(old.email) is distinct from lower(new.email))
     and not exists (select 1 from person p where p.organization_id = old.organization_id and p.id <> old.id and lower(p.email) = lower(old.email)) then
    delete from personal_token where organization_id = old.organization_id and kind = 'member' and email = lower(old.email);
    delete from portal_session where organization_id = old.organization_id and lower(email) = lower(old.email);
  end if;
  return coalesce(new, old);
end $$;
drop trigger member_tokens_follow_email on person;
create trigger member_tokens_follow_email after update of email or delete on person for each row execute function ov_member_tokens_follow_email();
