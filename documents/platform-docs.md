# NamiBarden — Platform Documentation

## What It Is
Nami Barden's personal website for spiritual and relationship coaching. Bilingual (JP/EN). Hybrid architecture: static landing pages + Node/Express backend for subscriptions, course purchases, and email marketing.

## User Types
- **Visitors**: Public, browse coaching content, sign up for newsletter
- **Subscribers**: Email list members, receive campaigns
- **Course Buyers**: Purchased access to video courses
- **Admin**: Gil/Nami — manages subscribers, campaigns, courses via protected dashboard

## Core Flows

### Visitor → Subscriber
1. Land on coaching page (EN or JP, toggleable)
2. Submit contact form / newsletter signup
3. Stored in subscribers table → Gmail notification fires
4. Admin can send campaigns to subscriber list

### Course Purchase
1. Visitor browses course library
2. Clicks buy → Stripe checkout (JPY pricing)
3. On success: unique access token generated, emailed to buyer
4. Token grants time-limited access to course videos
5. Videos served from Cloudflare R2 via signed URLs

### Email Campaigns
1. Admin logs in (JWT-protected dashboard)
2. Compose campaign → send to subscriber segments
3. Open/click/bounce tracking via event log
4. Unsubscribe handling (token-based)

### Admin Dashboard
- Manage subscribers (view, filter, export)
- Create + send email campaigns with tracking
- Manage course content and access
- View payment/subscription history
- JWT auth — admin only

## Key Screens
- `/` — Bilingual landing page (coaching positioning, testimonials)
- `/courses` — Video course library
- `/courses/[id]` — Course detail + purchase CTA
- `/watch/[token]` — Video player (token-gated)
- `/admin` — Protected admin dashboard
- YouTube feed section — latest 3 videos via RSS proxy (no API key)

## Tech Stack
- Frontend: Static HTML/CSS/JS (no framework — pure vanilla)
- Backend: Node.js / Express (runs on port 3100)
- Server: nginx (static files + reverse proxy to /api/*)
- Database: PostgreSQL 17-alpine
- Auth: JWT (admin only)
- Payments: Stripe (JPY, one-time + subscription)
- Email: Nodemailer (Gmail SMTP)
- Storage: Cloudflare R2 (video files, signed URLs)
- i18n: Client-side localStorage toggle (EN ↔ JP)
- Deploy: docker-compose build && docker-compose up -d

## Data Models (key relationships)
- Subscriber — email, name, status (active/unsubscribed/bounced), unsubscribe_token
- Campaign — subject, body, sent_at, stats
- CampaignRecipient — subscriber × campaign, delivery status
- EmailEvent — open/click/bounce per recipient
- Customer — Stripe customer_id mapping
- Subscription — Stripe subscription status, renewal dates
- Payment — invoice tracking
- CourseAccess — purchase token, course_id, expiry

## Languages
- Japanese primary market (JPY pricing, JP landing page default)
- English secondary (toggle in nav)

## Notes
- Rate limiting: in-memory Map (not Redis — keep it simple)
- No user accounts for buyers — token-based access only
- Gmail SMTP for email (not a dedicated ESP — works for current volume)
