-- OAuth 2.1 for /mcp (change agent-access, slice 4): an authorization code is a signed blob; only its single use is
-- stored, in the same transaction as the grant, so a second redemption fails on the key (also across instances).
create table oauth_code (
  nonce uuid primary key,
  used_at timestamptz not null default now()
);
create index oauth_code_used on oauth_code (used_at);
