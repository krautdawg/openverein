-- Personal access tokens for agents (change agent-access): an admin access's or a member's own token, and the
-- call log the owner sees. Club API keys (api_token) stay as they are.
create table personal_token (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization on delete cascade,
  kind text not null check (kind in ('admin', 'member')),
  -- admin: the access it acts as; member: the portal address it acts as (lower case)
  user_id uuid references app_user on delete cascade,
  email text,
  name text not null check (length(name) between 1 and 80),
  prefix text not null,
  token_hash text not null unique,
  access text not null check (access in ('read', 'write')),
  -- admin only: module -> highest level; null = everything the access may do
  cap jsonb,
  -- 'mcp': valid only at /mcp (OAuth grants)
  audience text check (audience in ('mcp')),
  oauth_client text,
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint personal_token_owner check ((kind = 'admin' and user_id is not null and email is null) or (kind = 'member' and email is not null and user_id is null and cap is null)),
  constraint personal_token_email_lower check (email = lower(email))
);
create index personal_token_user on personal_token (user_id) where user_id is not null;
create index personal_token_email on personal_token (organization_id, email) where email is not null;

-- Who called what: method and route pattern only (no ids, query, body or IP), kept 90 days.
create table agent_call (
  id bigint generated always as identity primary key,
  token_id uuid not null references personal_token on delete cascade,
  at timestamptz not null default now(),
  operation text not null,
  channel text not null check (channel in ('rest', 'mcp', 'cli')),
  status int not null
);
create index agent_call_token on agent_call (token_id, at desc);
create index agent_call_at on agent_call (at);

-- A job started by an agent runs with the token's narrowed rights and stops when the token goes.
alter table job add column token_id uuid references personal_token on delete set null;

-- A member token belongs to an address: when a person's address changes (edit, accepted change request, erasure),
-- tokens for the old address go with their call log, unless another person of the club still has that address.
create function ov_member_tokens_follow_email() returns trigger language plpgsql as $$
begin
  if old.email is not null and lower(old.email) is distinct from lower(new.email)
     and not exists (select 1 from person p where p.organization_id = old.organization_id and p.id <> old.id and lower(p.email) = lower(old.email)) then
    delete from personal_token where organization_id = old.organization_id and kind = 'member' and email = lower(old.email);
  end if;
  return new;
end $$;
create trigger member_tokens_follow_email after update of email on person for each row execute function ov_member_tokens_follow_email();
