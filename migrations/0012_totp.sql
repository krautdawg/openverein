-- Slice 10: TOTP second factor (mandatory for finance roles), recovery codes, step-up, session list.

alter table app_user
  add column totp_secret_encrypted text,
  add column totp_enabled_at timestamptz,
  -- last accepted time step, so a code cannot be replayed within its window
  add column totp_last_step bigint;

create table totp_recovery_code (
  id uuid primary key default uuidv7(),
  user_id uuid not null references app_user(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz
);
create index totp_recovery_user_idx on totp_recovery_code (user_id) where used_at is null;

-- When the session last confirmed the second factor (sign-in or step-up).
alter table session add column mfa_at timestamptz;
