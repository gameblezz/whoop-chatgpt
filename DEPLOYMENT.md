# Deployment and environment setup

## Hosting requirements

Use one long-running Node.js 24 process or the included Docker image, a persistent disk, and an HTTPS reverse proxy. The app needs outbound HTTPS to `api.prod.whoop.com` and `api.openai.com`. Static hosting (GitHub Pages) and ephemeral serverless filesystems are unsuitable. No database migrations or package installation are needed; the application creates its tables on startup.

Deploy the reviewed branch/commit. Set the variables below through your host's secret/environment UI. Mount a persistent volume at `/app/data` in Docker (or another private writable location for direct Node hosting). Run exactly **one replica and one worker**. Stop the old process before starting the replacement; do not overlap rolling deployments against the same WHOOP grant.

## Environment variables

| Name | Value |
| --- | --- |
| `APP_URL` | Exact HTTPS origin, e.g. `https://whoop.example.com`; no path/query |
| `WHOOP_CLIENT_ID` | Client ID from the existing WHOOP Developer App |
| `WHOOP_CLIENT_SECRET` | Client Secret from that app; server secret only |
| `WHOOP_ALLOWED_EMAIL` | Your WHOOP account email; all other accounts are refused |
| `TOKEN_ENCRYPTION_KEY` | One stable random 32-byte key encoded as base64 |
| `DATABASE_PATH` | `/app/data/whoop.sqlite` for Docker; persistent private path otherwise |
| `OPENAI_API_KEY` | Server-side OpenAI project API key; optional for dashboard-only use |
| `OPENAI_MODEL` | Responses-compatible model available to the key; default `gpt-4.1-mini` |
| `PORT` | Internal listen port, default `3000` |

Generate the encryption key locally once:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Save it securely in the hosting secret manager. Keep it stable across deploys and back it up separately from the database. Losing/changing it makes existing tokens unreadable. There are no `PUBLIC_`/frontend secrets. Never place credentials in Docker build arguments, source code, URLs, PRs, screenshots or chat messages. `.env` and database files are ignored by Git and excluded from the container image.

## Docker on a server

Copy `.env.example` to `.env`, fill it privately, and set `APP_URL` to your HTTPS origin.

```sh
docker compose up -d --build
```

The included Compose file binds port 3000 to localhost only and persists SQLite in the `whoop-data` volume. Put your HTTPS reverse proxy in front of `127.0.0.1:3000`. For example, a host-installed Caddy can use:

```caddyfile
whoop.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Replace the domain and point its DNS at the server. Configure the proxy/host to avoid logging callback query strings, cookies, Authorization headers or bodies. Do not enable Caddy access logging for this site without appropriate redaction. Allow sufficient proxy request time for chat (up to 180 seconds); each provider request also has a bounded timeout. Use `/healthz` for liveness.

For a managed Docker host, deploy the Dockerfile, route HTTPS to internal port 3000, configure these environment variables, attach a persistent volume owned by the container's `node` user (UID 1000), and choose one replica. For direct Node hosting start `node src/server.js` with the environment supplied by the platform. Never expose the data directory through a web/static-file server.

## Finish the existing WHOOP app setup

In the WHOOP Developer Dashboard:

1. Change Redirect URI from `https://gameblezz.github.io/whoop-chatgpt/callback.html` to `https://YOUR-ACTUAL-DOMAIN/auth/whoop/callback`. It must match `APP_URL` plus that path exactly.
2. Keep the Privacy Policy URL `https://gameblezz.github.io/whoop-chatgpt/` after merging the updated policy, or use `https://YOUR-ACTUAL-DOMAIN/privacy`.
3. Enable the six read scopes listed in README. The authorization request adds `offline` to obtain rotating refresh tokens.
4. Open the deployed application and connect with your own WHOOP account. Do not open `callback.html` or copy the returned code.

The root repository `index.html` remains the GitHub Pages privacy policy; the backend serves the actual app from `public/index.html`. Both URLs serve different purposes intentionally.

## Live acceptance checks

The automated suite uses mocked providers. Before treating the deployment as live:

1. Visit `/healthz`, then verify the signed-out app loads over HTTPS.
2. Connect WHOOP. Verify the address returns to `/` with no code in it and another account is rejected.
3. Inspect each of the six data types. Empty/unscored records may be normal; missing permission is an error, not zero data.
4. Select 7 days, enable AI consent, and ask a question. Check that the answer's values/dates match WHOOP and that no-consent requests are refused.
5. Wait for token expiry, then load data to confirm automatic refresh. Restart the one process and confirm the connection survives using the same key and volume.
6. Disconnect. Verify the session ends, stored tokens are deleted, and WHOOP access is revoked. Reconnect if you want to keep using it.

Do not log tokens to diagnose failures. An expired/revoked grant requires reconnecting. A scope error requires enabling the scope in WHOOP and authorizing again. `account_not_allowed` means the email does not match `WHOOP_ALLOWED_EMAIL`. An OAuth-state error usually means expired authorization, blocked cookies, an origin mismatch, or attempting to finish in a different browser.

## Backup, deletion and key rotation

Back up the database using SQLite's backup mechanism or with the server stopped so WAL state is consistent. Treat backups as private even though token payloads are encrypted. The user ID and session metadata are not encrypted fields. Set explicit backup expiry; disconnect/local deletion cannot erase copies from old backups or provider logs. Protect local filesystem permissions and disk encryption on the host.

For simple key rotation: disconnect while the old key is available, stop the app, change the key, and restart/reconnect. If the old key is lost, revoke the app in WHOOP first, stop the server, remove the old database together with its WAL/SHM files from the configured data directory, and reconnect with a new key. Never restore expired rotating refresh tokens from a stale backup expecting them to work.

Rate limits are in memory and reset on restart. Configure an independent OpenAI project budget and monitor hosting cost. For multiple users or replicas, add durable per-user budgets, shared session storage, cross-process token locks, and a proper account-management design before expanding this personal app.
