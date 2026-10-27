-- OIDC sign-in by the provider's stable identity (issuer, subject), not by the e-mail address, which a provider may
-- hand to someone else later (OIDC Core 5.7; Codex review G16). The e-mail only finds the access for the first link.
create table oidc_identity (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization (id) on delete cascade,
  issuer text not null,
  subject text not null,
  user_id uuid not null references app_user (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (organization_id, issuer, subject),
  unique (organization_id, issuer, user_id)
);
