#!/bin/sh
set -eu

# The app data folder. An install from before the rename has its volume at
# /var/lib/stasharr; keep using that when it's the one mounted.
if [ -z "${APP_DATA_DIR:-}" ]; then
  APP_DATA_DIR=/var/lib/stashboard
  if [ -d /var/lib/stasharr ] && [ -n "$(ls -A /var/lib/stasharr 2>/dev/null)" ] &&
    [ -z "$(ls -A /var/lib/stashboard 2>/dev/null)" ]; then
    APP_DATA_DIR=/var/lib/stasharr
    echo "Using the app data folder from before the rename (/var/lib/stasharr). Map your volume to /var/lib/stashboard when convenient."
  fi
fi
export APP_DATA_DIR
SESSION_SECRET_FILE="${SESSION_SECRET_FILE:-${APP_DATA_DIR%/}/session-secret}"

# What Stashboard itself keeps in its folders: the session secret, the log
# files, the media cache folder and its <sha256>.bin/.json files (and .tmp
# ones mid-write).
is_stashboard_entry() {
  case "$1" in
    .stashboard | .stasharr | session-secret | session-secret.tmp | media-cache | logs) return 0 ;;
    *.bin | *.json | *.tmp) return 0 ;;
  esac
  return 1
}

# Hands a folder to PUID:PGID. Everything inside changes owner only when the
# folder is Stashboard's alone: new, marked, or holding nothing but its own
# files. A folder that also holds other apps' data (say /mnt/user/appdata
# mapped instead of /mnt/user/appdata/stashboard) keeps their owners, so
# Stashboard never takes another app's database away from it.
take_ownership() {
  dir="$1"
  # .stasharr: the mark from before the rename.
  if [ ! -e "$dir/.stashboard" ] && [ ! -e "$dir/.stasharr" ]; then
    for entry in "$dir"/* "$dir"/.[!.]*; do
      [ -e "$entry" ] || continue
      if ! is_stashboard_entry "$(basename "$entry")"; then
        echo "Warning: $dir also holds files Stashboard didn't create ($(basename "$entry")), so their owners are left alone. Give Stashboard a folder of its own." >&2
        chown "$PUID:$PGID" "$dir" 2>/dev/null || true
        # Its own entries still have to be readable by it.
        for own in "$dir/session-secret" "$dir/media-cache" "$dir/logs"; do
          [ -e "$own" ] && find "$own" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown "$PUID:$PGID" {} +
        done
        return 0
      fi
    done
    touch "$dir/.stashboard" 2>/dev/null || true
  fi
  # Only touch what isn't owned yet, so restarts stay fast.
  if ! find "$dir" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown "$PUID:$PGID" {} +; then
    echo "Warning: could not give $dir to $PUID:$PGID" >&2
  fi
}

# Started as root: hand the app's own folders to PUID:PGID (default 99:100,
# Unraid's nobody:users), then re-run this script as that user. The app only
# deletes media it is allowed to, so set PUID/PGID to whoever owns your media.
# PUID=0 keeps running as root.
if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-99}"
  PGID="${PGID:-100}"
  case "$PUID" in "" | *[!0-9]*) echo "PUID must be a number, got: $PUID" >&2; exit 1 ;; esac
  case "$PGID" in "" | *[!0-9]*) echo "PGID must be a number, got: $PGID" >&2; exit 1 ;; esac

  if [ "$PUID" != "0" ]; then
    mkdir -p "$APP_DATA_DIR"
    take_ownership "$APP_DATA_DIR"
    if [ -n "${MEDIA_CACHE_DIR:-}" ]; then
      mkdir -p "$MEDIA_CACHE_DIR"
      take_ownership "$MEDIA_CACHE_DIR"
    fi
    echo "Running as user $PUID, group $PGID"
    export HOME=/tmp
    exec su-exec "$PUID:$PGID" /bin/sh "$0" "$@"
  fi
  echo "PUID=0: running as root"
fi

if [ -z "${SESSION_SECRET:-}" ]; then
  session_secret_dir="$(dirname "$SESSION_SECRET_FILE")"
  mkdir -p "$session_secret_dir"
  chmod 700 "$session_secret_dir"

  if [ -s "$SESSION_SECRET_FILE" ]; then
    export SESSION_SECRET="$(tr -d '\r\n' < "$SESSION_SECRET_FILE")"

    if [ -z "$SESSION_SECRET" ]; then
      echo "Persisted session secret file is empty: $SESSION_SECRET_FILE" >&2
      exit 1
    fi

    echo "Loaded persisted session secret from $SESSION_SECRET_FILE"
  else
    session_secret_tmp_file="${SESSION_SECRET_FILE}.tmp"
    SESSION_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64"))')"
    if [ -z "$SESSION_SECRET" ]; then
      echo "Could not generate a session secret" >&2
      exit 1
    fi
    export SESSION_SECRET
    printf '%s\n' "$SESSION_SECRET" > "$session_secret_tmp_file"
    chmod 600 "$session_secret_tmp_file"
    mv "$session_secret_tmp_file" "$SESSION_SECRET_FILE"
    echo "Generated and persisted a session secret at $SESSION_SECRET_FILE"
  fi
else
  echo "Using configured SESSION_SECRET from environment"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  if [ -z "${POSTGRES_DB:-}" ] || [ -z "${POSTGRES_USER:-}" ] || [ -z "${POSTGRES_PASSWORD:-}" ] || [ -z "${DATABASE_HOST:-}" ]; then
    echo "DATABASE_URL is unset and POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD, and DATABASE_HOST were not all provided" >&2
    exit 1
  fi

  database_port="${DATABASE_PORT:-5432}"
  # Percent-encode credentials so passwords containing @ / : # ? % still work.
  encoded_user="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$POSTGRES_USER")"
  encoded_password="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$POSTGRES_PASSWORD")"
  encoded_db="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$POSTGRES_DB")"
  export DATABASE_URL="postgresql://${encoded_user}:${encoded_password}@${DATABASE_HOST}:${database_port}/${encoded_db}?schema=public"
  echo "Derived DATABASE_URL for ${DATABASE_HOST}:${database_port} from shared POSTGRES_* values"
fi

max_attempts="${DATABASE_MIGRATION_MAX_ATTEMPTS:-30}"
retry_delay_seconds="${DATABASE_MIGRATION_RETRY_DELAY_SECONDS:-2}"
attempt=1

echo "Applying Prisma migrations"
while ! /app/node_modules/.bin/prisma migrate deploy --schema /app/prisma/schema.prisma; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "Prisma migrations did not succeed after ${attempt} attempts" >&2
    exit 1
  fi

  echo "Database not ready yet, retrying in ${retry_delay_seconds}s (${attempt}/${max_attempts})" >&2
  attempt=$((attempt + 1))
  sleep "$retry_delay_seconds"
done

echo "Starting Stashboard"
exec node /app/apps/sp-api/dist/main.js
