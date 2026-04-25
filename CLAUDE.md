# NamiBarden — namibarden.com

Nami Barden's personal/spiritual coaching website. Gil manages it.

## Stack
- Frontend: Static HTML/CSS/JS served by nginx (bilingual Japanese/English)
- Backend: Node.js/Express on port 3100 (API routes, admin dashboard)
- Database: PostgreSQL 17 (contacts, bookings, admin data)
- Container: nginx + Node.js in single container, Traefik for SSL

## Structure
```
public/          # Static site files (HTML, CSS, JS, images)
admin/           # Admin dashboard (JWT-protected)
server.js        # Express API server (port 3100)
schema.sql       # DB schema (loaded on first run)
nginx.conf       # HTTP server block — proxies /api/ to Node
nginx-main.conf  # Main nginx config (workers, brotli)
security-headers.conf  # Shared security headers (included by nginx.conf)
```

## Key Patterns
- nginx serves static files, proxies /api/* to Express on 127.0.0.1:3100
- YouTube section: /api/youtube-feed proxies RSS from YouTube (no API key needed)
- Language toggle: localStorage-based, client-side switching
- Security headers consolidated in security-headers.conf (included 3x in nginx.conf)
- Rate limiting implemented in-memory via Map

## Deploy
Docker Compose with Traefik labels. Push to main does NOT auto-deploy (Coolify auto-deploy was disabled because app outgrew Coolify — runs its own docker-compose now).
```bash
cd /projects/NamiBarden && docker-compose build && docker-compose up -d
```

## Database
- Container: namibarden-db (postgres:17-alpine)
- User: namibarden, DB: namibarden
- Volume: namibarden-pgdata
- Schema auto-loaded from schema.sql on first run

## Contact/Notification
- /api/contact sends notifications to namibarden@gmail.com (changed 2026-02-28)
- SMTP via Gmail (configured in .env)

## Staging — staging.namibarden.com
Tailscale-only mirror at `staging.namibarden.com` (Cloudflare proxy off, Traefik `tailscale-only` middleware that allowlists `100.64.0.0/10`). Used to exercise billing/Stripe changes before they hit prod.

Compose project name is `namibarden-staging` (separate from prod `namibarden`) so prune/orphan ops never cross-contaminate. The `IS_STAGING_ENV` sentinel in `.env.staging` makes compose refuse to start the staging stack if `--env-file .env.staging` is omitted (which would otherwise silently fall back to prod's `.env`).

```bash
# Bring staging up / rebuild
cd /root/projects/NamiBarden && docker compose -f docker-compose.staging.yml --env-file .env.staging up -d --build

# Reset staging DB to fresh fixtures
docker compose -f docker-compose.staging.yml --env-file .env.staging down -v
docker compose -f docker-compose.staging.yml --env-file .env.staging up -d
```

Containers: `namibarden-staging`, `namibarden-staging-db`, `namibarden-staging-mail` (Mailpit).
Mail UI at `https://mail.staging.namibarden.com` (Tailscale-only) catches all SMTP — no real mail leaves. *(Note: only Nodemailer/SMTP is captured. If a future change adds API-based mail (Resend/SendGrid/Mailgun), route it through Mailpit too or it'll bypass.)*

### Accessing staging from a Tailscale-connected laptop
Public DNS resolves `staging.namibarden.com` → public IP `89.167.12.82`, but Traefik's `tailscale-only` middleware will 403 your request because your browser arrives from your laptop's *public* IP, not from the `100.64.0.0/10` tailnet range. Two options:

```bash
# (a) Force routing through Hetzner's Tailscale IP for ad-hoc curls
curl --resolve staging.namibarden.com:443:100.83.80.116 https://staging.namibarden.com/

# (b) For browser/Stripe-CLI use, override DNS via /etc/hosts on your laptop:
#     100.83.80.116  staging.namibarden.com mail.staging.namibarden.com
```

### Stripe webhook
Real route is `POST /api/stripe/webhook`. Run the CLI locally on a Tailscale-connected machine:
```bash
stripe listen --forward-to https://staging.namibarden.com/api/stripe/webhook
```
The app refuses to boot if `STRIPE_SECRET_KEY` starts with `sk_live_` while `NODE_ENV != production` — so a copy-paste of a live key fails fast instead of leaking real charges.

### Fixtures
`seed-staging.sql` inserts: one subscriber, one customer, one contact. The admin user is **not** seeded — `app-startup.js` creates it from `ADMIN_PASSWORD` in `.env.staging` on first boot, so that env var is the single source of truth. `LUMINA_URL` is intentionally empty; the app uses an `…invalid` sentinel host instead of falling back to prod Lumina, so any Lumina-dependent flow fails noisily until Lumina staging exists.

### Schema bind-mount
Both prod and staging mount the working-tree `schema.sql` into their DB containers. Prod skips re-init because its data dir exists; staging re-applies on every `down -v`. So editing `schema.sql` directly is how you test schema changes against staging — but the same edit will hit prod next time prod is bootstrapped from scratch (e.g., disaster-recovery rebuild). For prod-affecting schema changes, also add a migration run via `psql`.
