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
