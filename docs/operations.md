# Operations

## Install on a server

You need a Linux server with Docker (Compose v2), a domain whose DNS points to the server, ports 80 and 443 open, and an SMTP account for outgoing mail.

```sh
git clone https://github.com/krautdawg/openverein.git && cd openverein
./ovctl install      # asks for domain, mail server and sender; creates deploy/.env (mode 600) with a database password and DATA_KEY
```

Caddy fetches the HTTPS certificate on its own. Open `https://<domain>` and create the club and the first admin.

**DATA_KEY** in `deploy/.env` encrypts bank details. The database stores a fingerprint of it; a server started with a different key stops with "DATA_KEY passt nicht zu dieser Datenbank" instead of writing bank details with a second key (for example after restoring a backup onto a new server: copy the old `DATA_KEY` into `deploy/.env` first). Without it, a backup's IBANs cannot be read. Keep a copy apart from the backups (password manager, sealed envelope with the board), not on the same disk.

## Back up, restore, update, check

```sh
./ovctl backup               # database (pg_dump) and files into backups/openverein-<time>/ with SHA256SUMS; keeps the last 14
                             # (the app stops for the seconds this takes, so both halves match; every stored file is checked)
./ovctl restore backups/openverein-20261024-0300   # checks the sums, backs up the current state first, then restores
./ovctl update               # backup, git pull, rebuild, restart; if the new version does not come up, it prints the commands to go back (code and data together)
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

## Managed hosting: several clubs on one installation

For clubs without a technical volunteer, one operator can host several clubs on one OpenVerein installation. Every table already carries the club (`organization_id`); each club is reached under its own host name, for example `tsv-musterstadt.example-hosting.de`.

1. Set `MULTI_TENANT=true` and an `OPERATOR_TOKEN` of at least 32 random characters (from your secret store). `DEMO_MODE` cannot be combined with it. The open setup page is closed then.
2. Point each club's host name at the server. With Caddy, use a wildcard certificate or on-demand TLS restricted to the host names you created (Caddy's `ask` endpoint), so nobody can make the server request certificates for arbitrary names.
3. Create a club with its first admin:

   ```sh
   curl -X POST https://<any-host>/api/v1/operator/tenants \
     -H "X-Operator-Token: $OPERATOR_TOKEN" -H 'content-type: application/json' \
     -d '{"clubName":"TSV Musterstadt 1890 e.V.","hostname":"tsv-musterstadt.example-hosting.de","adminName":"Erika Mustermann","adminEmail":"vorstand@tsv-musterstadt.de"}'
   ```

   The admin gets an invitation mail with a link on the club's host name (the answer also contains the link, valid for seven days). `GET /api/v1/operator/tenants` lists the clubs; `PATCH /api/v1/operator/tenants/<id>` changes a host name or name.

Under managed hosting, mail goes out from the operator's address (`MAIL_FROM`) with the club's name; the club's own address becomes the Reply-To, so no club can send as another club's domain through the shared server. `MAIL_PER_MINUTE_MAX` (default 60) caps each club's sending rate. Application forms and public calendars answer only on their own club's host name. Switching an existing single-club installation to `MULTI_TENANT=true`: set the club's host name first (`PATCH /api/v1/operator/tenants/<id>`), otherwise nobody can sign in.

What a club sees and does stays inside its club: members, mails, files, the portal (the portal signs members in for the club whose host name they use) and the full export under Einstellungen → Gesamtexport. One e-mail address can be an admin access in one club only. Mail goes out per club, each with its own rate and pause switch.

As operator you process the clubs' data on their behalf: conclude a data-processing agreement (Art. 28 GDPR) with each club. `docs/avv-vorlage.md` is a German template with the technical and organisational measures OpenVerein brings and a part for your own operations.

### When a club leaves

1. Hand over its data. The club's admins can download it themselves (Einstellungen → Gesamtexport), or you fetch it:

   ```sh
   curl -o tsv-musterstadt.zip https://<any-host>/api/v1/operator/tenants/<id>/export.zip -H "X-Operator-Token: $OPERATOR_TOKEN"
   ```

   The archive is the full export described in `export-schema.md`, with all files (never cached: `Cache-Control: private, no-store`). It is built in memory: for clubs with many hundreds of megabytes of files, make sure the server has the memory, or let the club download its export itself. It contains members' bank details: store and send it like any other personal data.
2. Delete the club with everything it owns. To confirm, give the club's host name:

   ```sh
   curl -X DELETE https://<any-host>/api/v1/operator/tenants/<id> -H "X-Operator-Token: $OPERATOR_TOKEN" \
     -H 'content-type: application/json' -d '{"confirmHostname":"tsv-musterstadt.example-hosting.de"}'
   ```

   The answer counts the deleted rows per table. Issued invoices, the journal and receipts are protected by database triggers. The deletion therefore runs with triggers switched off, which needs a superuser database connection, as in the supplied Docker setup. Before committing, it checks every foreign key: if any row of another club still pointed into the deleted one, nothing is deleted. The club's files go with the next file sweep (within a day). Its rows stay in your backups until they expire (AVV section 6.2). The club's own log is deleted with it. The deletion and every export are recorded in the append-only table `operator_event`, which outlives the club. The deletion is also written to the erasure log, so if you restore an older backup that still contains the club, OpenVerein deletes it again at start-up.

Per-club backups are not included yet: `ovctl backup` backs up the whole installation.

## KI Klub Werder: Profile übernehmen

Die Profile des KI Klub (`klub_profil`, `klub_profil_link`, Fotos als `bytea`) übernimmt ein Skript. Es ordnet sie den Mitgliedern über die E-Mail-Adresse zu und schreibt erst mit `--confirm`.

```bash
# erst ein Probelauf gegen eine Kopie der KI-Klub-Datenbank (nie gegen die laufende)
npm run import:kiklub-profiles -- --source postgres://…/kiklub_kopie [--schema public] [--club <Hostname oder ID>]
# dann schreiben
npm run import:kiklub-profiles -- --source postgres://…/kiklub_kopie --confirm
```

- **Profilarten:** KI-Enthusiast und KI-Profi kommen dazu, falls es sie noch nicht gibt.
- **Freigaben:** die Freigaben aus dem KI Klub bleiben.
- **Kontakt:** die Sichtbarkeit wird übersetzt: Vorstand, Mitglieder, öffentlich.
- **LinkedIn:** das Feld wird zum ersten Link.
- **Übersprungen** werden:
  - Profile ohne passendes Mitglied
  - Adressen mit mehreren Mitgliedschaften
  - ungültige Links
  - Fotos, die kein JPG, PNG oder WebP sind oder größer als 2 MB
- **Fotos:** öffentlich erst, wenn die Person in OpenVerein in „Fotos auf Website und in sozialen Medien“ eingewilligt hat. Das Skript nennt die Zahl der Fotos ohne Einwilligung.
