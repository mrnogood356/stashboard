# Stashboard

Stashboard is a self-hosted console that discovers scenes from a supported catalog provider, sends acquisitions to Whisparr, and validates availability against your local Stash library.

[![Latest release](https://img.shields.io/github/v/release/mrnogood356/stashboard?display_name=tag&sort=semver&style=for-the-badge)](https://github.com/mrnogood356/stashboard/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/mrnogood356/stashboard/ci.yml?branch=main&label=CI&style=for-the-badge)](https://github.com/mrnogood356/stashboard/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/mrnogood356/stashboard?&style=for-the-badge)](LICENSE)
[![Self-hosted](https://img.shields.io/badge/self--hosted-yes-0f766e?&style=for-the-badge)](#self-hosted-quick-start)
[![Deploy: Docker Compose](https://img.shields.io/badge/deploy-Docker%20Compose-2496ED?logo=docker&logoColor=white&style=for-the-badge)](#self-hosted-quick-start)
[![Auth: local admin](https://img.shields.io/badge/auth-local%20admin-475569?&style=for-the-badge)](#self-hosted-quick-start)

## What Stashboard Does

- Discover scenes through a configured catalog provider during first-run setup.
- Submit and track acquisition requests through Whisparr.
- Check local Stash availability so you can see what is already in your library.

- Browse FansDB next to StashDB (or the other way round): add the second provider in Settings → Integrations as an optional browse provider. Requests keep going through your chosen provider.
- Get Discord, ntfy or webhook notifications when requests start downloading, land in your library, or fail (Settings → Notifications).
- Watch your Stash library in Stashboard: a built-in player with resume, scrub previews, quality choice, picture-in-picture and AirPlay/Chromecast. Progress and play counts sync back to Stash, and a Continue Watching rail picks up where you left off. Files your browser can't play are converted by Stash on the fly, so Stash's live transcoding should be enabled.
- New scenes on autopilot (Settings → Automation): when Whisparr imports a scene, Stashboard has Stash scan for it, identify it on StashDB and generate its previews. Add Stashboard's webhook in Whisparr to make it instant; otherwise it notices new imports on its own within about 15 minutes.
- Match & rename (Library tools): matches scenes Stash couldn't identify using every source it can reach: your main catalog (StashDB), every other stash-box set up in Stash (FansDB, ThePornDB…), ThePornDB from its API key, and finally Stash's own scrapers. It tries video fingerprints first, then the file name, and shows the likely matches with covers and reasons so you can pick one. You can also search StashDB yourself. "Match all" saves only the sure matches and can run every night. The renamer moves matched files into a pattern such as `{studio}/{date} - {title}`. It shows a preview first, can run automatically after each match, leaves Whisparr's own files alone, and the last run can be undone.
- Send to Whisparr: scenes you match to StashDB that Whisparr shows as missing are handed to Whisparr's Manual Import, so Whisparr counts them as downloaded and takes over the file (move, or hardlink/copy). "Send them now" catches up on everything Stash has that Whisparr is missing. If Stash and Whisparr see your media under different paths, set the folder mapping on the Match tab and tap "Save and check".
- Empty folders (Rename tab): removes folders left empty after renames, Unmatched moves and Whisparr moves, and has a one-tap cleanup for the whole library. It never removes library or Whisparr root folders. Stashboard needs to see your media for this: mount the same media path into the Stashboard container as Stash uses (for example host `/mnt/user/data` → container `/data`).
- Repair Whisparr (Rename tab): when Whisparr shows scenes as missing because it's looking in the wrong folder, this points them back at the right root folder without moving anything, rescans, and re-imports the rest from where Stash has them.
- Pick a release: on a requested scene, see every release your indexers found (quality, size, seeders, age, why Whisparr would skip it) and download the one you want.
- App Lock (Settings → Privacy): require a PIN to reopen Stashboard after it's been in the background, enforced by the server. Face ID works too when Stashboard is opened over HTTPS with a domain name. Stashboard also tries to cover the screen when you leave, but iOS can still show a preview in the app switcher.
- Install it on your phone: in Safari use Share → Add to Home Screen; in Chrome use Install app.

## What You Need

- Docker and Docker Compose on the machine that will run Stashboard
- An existing Stash instance that Stashboard can reach
- An existing Whisparr instance that Stashboard can reach
- A supported catalog provider to configure during setup: StashDB or FansDB

## Self-Hosted Quick Start

Normal self-hosted installs do not require a repo checkout or a separate `.env` file. Create an empty folder, save the following as `compose.yaml`, change the database password once before first start, and optionally change the host port or pin the image tag. This snippet matches [`infrastructure/compose/compose.example.yaml`](infrastructure/compose/compose.example.yaml).

```yaml
x-db-env: &db-env
  POSTGRES_DB: stashboard
  POSTGRES_USER: stashboard
  # Change this once before your first start.
  POSTGRES_PASSWORD: change-this-password

services:
  postgres:
    image: postgres:17-alpine
    environment:
      <<: *db-env
    volumes:
      - stashboard_postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB']
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 10s
    restart: unless-stopped

  app:
    # Change latest to an exact release like v0.1.0 if you want to pin upgrades.
    image: ghcr.io/mrnogood356/stashboard:latest
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - stashboard_app_data:/var/lib/stashboard
    environment:
      <<: *db-env
      DATABASE_HOST: postgres
      DATABASE_URL: ""
      HOST: 0.0.0.0
      PORT: 3000
      DATABASE_MIGRATION_MAX_ATTEMPTS: 30
      DATABASE_MIGRATION_RETRY_DELAY_SECONDS: 2
      # Optional advanced override. Leave unset to let Stashboard generate and persist
      # a unique session secret for this install in the app data volume.
      # SESSION_SECRET: your-own-long-random-secret
      # Optional: uncomment if catalog provider checks time out on IPv4-only Docker networks.
      # NODE_OPTIONS: --no-network-family-autoselection
      # Optional: set to true when serving Stashboard over HTTPS.
      SESSION_COOKIE_SECURE: "false"
      # The user Stashboard runs as. It can only rename and clean up media this user
      # may change, so match your media's owner (Unraid: 99/100; most Linux: 1000/1000).
      PUID: 99
      PGID: 100
    ports:
      # Change the left side if port 3000 is already in use on the host.
      - "3000:3000"
    restart: unless-stopped

volumes:
  stashboard_postgres_data:
    name: stashboard_postgres_data
  stashboard_app_data:
    name: stashboard_app_data
```

Both services reuse the same `POSTGRES_*` values from `x-db-env`, so you change the database password in one place only. On first boot, Stashboard automatically generates a unique session secret for that install and persists it in the app data volume. You only need to set `SESSION_SECRET` yourself if you want an advanced manual override.

Then start Stashboard with:

```bash
docker compose up -d
```

Open `http://localhost:3000`.

On the first visit, Stashboard opens a bootstrap screen until you create the single local admin account. After that, unauthenticated visits land on the login screen and normal app and API usage require that session.

If StashDB or FansDB Save & Test repeatedly fails with `ETIMEDOUT` on an IPv4-only Docker network, add
`NODE_OPTIONS: --no-network-family-autoselection` to the app service environment and restart the container.

Tag guidance:

- `latest` is the newest stable release and the recommended default.
- `vX.Y.Z` pins an exact release.
- `edge` follows unreleased builds from `main` and is meant for early adopters.

## Optional Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `TRUST_PROXY` | unset | Set to `true` (or a hop count like `1`) when Stashboard sits behind a reverse proxy, so login throttling sees each visitor's real address instead of the proxy's. |
| `DATABASE_PORT` | `5432` | Postgres port used when `DATABASE_URL` is derived from the `POSTGRES_*` values. |
| `MEDIA_CACHE_TTL_HOURS` | `24` | How long Stash screenshots and logos are kept in the image cache. |
| `MEDIA_CACHE_MAX_MB` | `512` | Size cap for the image cache; the oldest images are removed first. |
| `MEDIA_CACHE_DISABLED` | unset | Set to `true` to turn the image cache off. |
| `PUID` / `PGID` | `99` / `100` | The user and group Stashboard runs as (it starts as root only to hand its data folder to them). Folder cleanup and renames only work on media this user may change, so match your media's owner: `99`/`100` on Unraid, usually `1000`/`1000` elsewhere. `PUID=0` keeps running as root. |
| `CONTENT_SECURITY_POLICY` | report-only | Browser Content-Security-Policy. By default violations are only reported in the browser console; set to `enforce` to block them, or `off` to send no policy. |
| `ALLOW_EMBEDDING` | unset | Set to `true` to let dashboards such as Organizr or Homarr show Stashboard in an iframe. By default other sites can't frame it. |

The image cache lives in the app data volume (`/var/lib/stashboard/media-cache`).

## Updating

For the standalone `compose.yaml` install, pull the newest stable release and restart:

```bash
docker compose pull
docker compose up -d
```

If you pin releases, change the image tag in `compose.yaml` to the target `vX.Y.Z` first, then run the same commands. Stashboard applies Prisma migrations automatically when the app container starts.

Stashboard no longer runs as root: it runs as `PUID`/`PGID` (default `99`/`100`) and takes ownership of its data volume on the first start. If your media isn't owned by `99`/`100`, set `PUID` and `PGID` to its owner, or folder cleanup won't be able to remove anything.

## Rollback

To roll back, change the image tag in `compose.yaml` back to a known-good `vX.Y.Z`, then pull and restart:

```bash
docker compose pull
docker compose up -d
```

Rolling back the app image does not automatically roll back database schema changes. Take a database backup before upgrades, and be cautious about rolling back across releases that may have already applied newer migrations. If an older image cannot start cleanly against the migrated schema, restore the pre-upgrade database backup before retrying the rollback.

## Backups

Persistent PostgreSQL data lives in the named Docker volume from your compose file. The standalone example uses `stashboard_postgres_data`, and the repo-managed compose file uses `sp_postgres_data`. The app container also uses a small data volume for the generated session secret: `stashboard_app_data` in the standalone example and `sp_app_data` in the repo-managed compose file. Back up the database volume or take a logical database dump before upgrades. For a full restore, preserve:

- the `stashboard_postgres_data` Docker volume
- the `stashboard_app_data` Docker volume
- your `compose.yaml`

One practical logical backup command is:

```bash
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > stashboard-backup.sql
```

## Local Development

If you want to run the repo locally instead of the published image:

- install dependencies with `pnpm install`
- copy `.env.example` to `.env` and set `SESSION_SECRET`
- start Postgres with `pnpm run dev:db`
- run the backend with `pnpm run backend`
- run the frontend with `pnpm run web`

If an older local database says migration `20260402142846` was modified after it was applied, run `pnpm run db:repair-runtime-health-migration` once, then rerun `pnpm prisma migrate dev`.

## Contributing

For repo structure, release automation, CI expectations, PR conventions, and contributor deployment notes, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Stashboard is based on [Stasharr Portal](https://github.com/enymawse/stasharr-portal) by enymawse, and like it is licensed under the [GNU General Public License v3.0](LICENSE).
