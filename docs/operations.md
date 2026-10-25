# Operations

## Install on a server

You need a Linux server with Docker (Compose v2), a domain whose DNS points to the server, ports 80 and 443 open, and an SMTP account for outgoing mail.

```sh
git clone https://github.com/krautdawg/openverein.git && cd openverein
./ovctl install      # asks for domain, mail server and sender; creates deploy/.env (mode 600) with a database password and DATA_KEY
```

Caddy fetches the HTTPS certificate on its own. Open `https://<domain>` and create the club and the first admin.

**DATA_KEY** in `deploy/.env` encrypts bank details. Without it, a backup's IBANs cannot be read. Keep a copy apart from the backups (password manager, sealed envelope with the board), not on the same disk.

## Back up, restore, update, check

```sh
./ovctl backup               # database (pg_dump) and files into backups/openverein-<time>/ with SHA256SUMS; keeps the last 14
./ovctl restore backups/openverein-20261024-0300   # checks the sums, backs up the current state first, then restores
./ovctl update               # backup, git pull, rebuild, restart
./ovctl doctor               # services, health, DATA_KEY, free disk, age of the last backup, certificate expiry
./ovctl logs
```

Daily backup by cron, copied off the server (restic, rsync or the hoster's storage box):

```cron
15 3 * * * cd /opt/openverein && ./ovctl backup >> backups/backup.log 2>&1
```

Backups are rotated after 14 days. This also bounds how long an erased person survives in a backup. `BACKUP_KEEP` and `BACKUP_DIR` change the defaults.


## The only admin lost phone and recovery codes

Another admin can reset the second factor under Einstellungen → Zugänge. If there is none, reset it on the server (this ends the person's sessions; they set up TOTP again after signing in with their password):

```sh
docker compose exec db psql -U openverein openverein -c "
  update app_user set totp_secret_encrypted = null, totp_pending_secret_encrypted = null, totp_enabled_at = null, totp_last_step = null where lower(email) = lower('admin@example.org');
  delete from totp_recovery_code where user_id = (select id from app_user where lower(email) = lower('admin@example.org'));
  delete from session where user_id = (select id from app_user where lower(email) = lower('admin@example.org'));"
```

Note it in the club's records: the reset bypasses the audit log.

## Restoring a backup and erasures

Every anonymisation is written to the database (`erasure_log`) and appended to `FILES_DIR/erasure-log.jsonl`. At start-up the server mirrors missing database entries into the file and then anonymises again every person from the file that a restored database brought back, before it accepts requests.

This only works if the erasure file survives the restore. `ovctl restore` takes care of it: it keeps the current `erasure-log.jsonl` and merges it into the restored files. If you restore by hand, keep the current `erasure-log.jsonl` (do not roll the files volume back to the same date), or copy it back before starting the server.
