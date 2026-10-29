# Stashboard on Unraid

`stashboard.xml` is a Docker template for Unraid. Until Stashboard is listed in Community Applications, add it by hand:

1. **Install PostgreSQL.** In Community Applications, install a PostgreSQL 15 or newer app (for example `postgresql17`). Note the password you give it.
2. **Create Stashboard's database.** Open that container's console and run, with a password of your own:

   ```sh
   psql -U postgres -c "CREATE USER stashboard WITH PASSWORD 'change-this-password';"
   psql -U postgres -c "CREATE DATABASE stashboard OWNER stashboard;"
   ```

3. **Add the template.** In the Docker tab, choose **Add Container**, then paste this into **Template**:

   ```
   https://raw.githubusercontent.com/mrnogood356/stashboard/main/infrastructure/unraid/stashboard.xml
   ```

4. **Fill in the database fields.** Database host is your server's IP (or the PostgreSQL container's name if both are on the same custom network). Use the user and password from step 2.
5. **Map your media** (optional) to the same path Stash and Whisparr see, for example `/mnt/user/data` → `/data`. Renames and empty-folder cleanup need it.
6. **Apply,** then open the Web UI. Create your account and connect Stash, Whisparr and StashDB or FansDB.

Stashboard creates its tables on first start and runs as `99:100` (`nobody:users`), which owns Unraid media by default.

## Opening it from outside your network

Use a VPN such as Tailscale or WireGuard, or a reverse proxy with HTTPS (Nginx Proxy Manager, SWAG or a Cloudflare Tunnel). Behind HTTPS, set **Secure cookies** to `true` and **Trust proxy** to `true` under the template's advanced view. Don't forward port 3000 straight to the internet.

## Listing in Community Applications

Community Applications reads templates from a repository its maintainers have added. To get listed, follow the submission steps on the Unraid forum's Community Applications thread and point it at this folder.
