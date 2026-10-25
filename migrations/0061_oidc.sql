-- Sign-in through the club's identity provider (OIDC, roadmap P3.10); only for existing, active accesses.
alter table organization
  add column oidc_enabled boolean not null default false,
  add column oidc_issuer text check (oidc_issuer ~ '^https?://'),
  add column oidc_client_id text,
  add column oidc_client_secret_encrypted text,
  add column oidc_label text check (char_length(oidc_label) <= 60);
