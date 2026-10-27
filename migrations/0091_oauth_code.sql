-- OAuth 2.1 for /mcp (change agent-access, slice 4): authorization codes live here, not in the code itself. The
-- client gets a random code; only its hash is stored, with what the person allowed. Redeeming deletes the row in the
-- grant's transaction, so a code works once (also across instances), and neither a key leak nor the redirect URL
-- reveals or forges anything. Expired rows go in the hourly job.
create table oauth_code (
  code_hash text primary key,
  organization_id uuid not null references organization on delete cascade,
  -- who consented and for which client: a newer consent deletes the older pending codes ("newest consent wins")
  owner_key text not null,
  client_fingerprint text not null,
  payload jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index oauth_code_owner on oauth_code (organization_id, owner_key, client_fingerprint);
create index oauth_code_expiry on oauth_code (expires_at);
