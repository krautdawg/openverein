#!/usr/bin/env bash
# Live round trips of ovctl against a throwaway installation (Docker): backup -> change -> restore, with the backup
# folder spelled differently from the restore path, and a failed update that must roll code and data back.
# Usage: scripts/ovctl-roundtrip.sh   (needs Docker and git; takes a few minutes, mostly the image build)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
export COMPOSE_PROJECT_NAME="ovctl-roundtrip-$$"
export DOMAIN=localhost SMTP_URL=smtp://localhost:2525 MAIL_FROM='Test <test@example.org>'
export HTTP_PORT="${HTTP_PORT:-18080}" HTTPS_PORT="${HTTPS_PORT:-18443}"
export OVCTL_YES=1
# Keep one backup only: a restore whose safety backup pruned its own target would fail here.
export BACKUP_KEEP=1

say() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# A clean clone with its own bare "origin", so `ovctl update` can pull a broken commit.
git clone --quiet --bare "$REPO" "$WORK/origin.git"
# A branch of its own (CI checks out a detached commit): the install tracks it, the broken release is pushed to it.
git -C "$WORK/origin.git" update-ref refs/heads/roundtrip "$(git -C "$REPO" rev-parse HEAD)"
git -C "$WORK/origin.git" symbolic-ref HEAD refs/heads/roundtrip
git clone --quiet "$WORK/origin.git" "$WORK/install"
cd "$WORK/install"
# OVCTL_REF=<commit>: run an older ovctl against the same scenarios (to show a scenario fails without a fix).
if [ -n "${OVCTL_REF:-}" ]; then git -C "$REPO" show "$OVCTL_REF:ovctl" > ovctl; fi
dc() { docker compose --project-directory deploy -f deploy/compose.yml --env-file deploy/.env "$@"; }
cleanup() { dc down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

sql() { dc exec -T db psql -U openverein -d openverein -Atc "$1"; }
marker() { dc exec -T app sh -c 'cat /data/files/roundtrip-marker 2>/dev/null || echo none'; }
set_state() {
  sql "update organization set name = '$1'" >/dev/null
  dc exec -T app sh -c "mkdir -p /data/files && printf %s '$1' > /data/files/roundtrip-marker"
}
expect_state() {
  local name file
  name="$(sql 'select name from organization')"
  file="$(marker)"
  [ "$name" = "$1" ] || fail "club name is '$name', expected '$1'"
  [ "$file" = "$1" ] || fail "marker file is '$file', expected '$1'"
}

say "install"
./ovctl install
dc exec -T app node -e "fetch('http://localhost:3300/api/v1/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clubName:'Roundtrip e.V.',name:'Ada Admin',email:'ada@example.org',password:'ein-sehr-langes-passwort'})}).then(r=>process.exit(r.ok?0:1))"
set_state 'Stand A'

say "backup (backup folder spelled relative with a trailing slash)"
BACKUP_DIR=./backups/ ./ovctl backup
target="$(ls -1d "$PWD"/backups/openverein-* | tail -1)"
[ -f "$target/db.dump" ] && [ -f "$target/files.tar.gz" ] || fail "backup incomplete: $target"

if [ -z "${ROUNDTRIP_SKIP_RESTORE:-}" ]; then
  say "change, then restore"
  set_state 'Stand B'
  sleep 1 # the safety backup gets its own timestamp
  BACKUP_DIR=./backups/ ./ovctl restore "$target"
  expect_state 'Stand A'
  [ -d "$target" ] || fail "the restore pruned the backup it restored from"
fi

say "failed update rolls back"
before="$(git rev-parse HEAD)"
set_state 'Stand C'
git clone --quiet "$WORK/origin.git" "$WORK/broken"
(
  cd "$WORK/broken"
  printf "throw new Error('roundtrip: broken release');\n" | cat - src/server/index.ts > /tmp/ovctl-roundtrip-index.$$ && mv /tmp/ovctl-roundtrip-index.$$ src/server/index.ts
  git -c user.name=roundtrip -c user.email=roundtrip@example.org commit --quiet -am "broken release"
  git push --quiet origin HEAD:roundtrip
)
if ./ovctl update; then fail "update of a broken release reported success"; fi
[ "$(git rev-parse HEAD)" = "$before" ] || fail "code not rolled back (HEAD $(git rev-parse HEAD), expected $before)"
[ "$(git symbolic-ref --short -q HEAD)" != "" ] || fail "rolled back to a detached HEAD"
expect_state 'Stand C'
dc exec -T app node -e "fetch('http://localhost:3300/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" || fail "app not healthy after rollback"

say "all ovctl round trips passed"
