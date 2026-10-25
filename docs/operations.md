# Operations

## The only admin lost phone and recovery codes

Another admin can reset the second factor under Einstellungen → Zugänge. If there is none, reset it on the server (this ends the person's sessions; they set up TOTP again after signing in with their password):

```sh
docker compose exec db psql -U openverein openverein -c "
  update app_user set totp_secret_encrypted = null, totp_pending_secret_encrypted = null, totp_enabled_at = null, totp_last_step = null where lower(email) = lower('admin@example.org');
  delete from totp_recovery_code where user_id = (select id from app_user where lower(email) = lower('admin@example.org'));
  delete from session where user_id = (select id from app_user where lower(email) = lower('admin@example.org'));"
```

Note it in the club's records: the reset bypasses the audit log.
