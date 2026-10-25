-- Codex review of #8-#10.
-- Failed portal sign-ins are counted per address and day, also for addresses without any code (no member enumeration).
create table portal_verify_failure (
  email_hash text not null,
  day date not null,
  n int not null default 0,
  primary key (email_hash, day)
);

-- Rejected applications scrubbed earlier still held their keyed e-mail hash, IBAN ending and reason.
update application set email_hash = md5(random()::text || id::text), iban_last4 = null, reason = null
  where status = 'rejected' and payload = '{}'::jsonb;
