# NamiBarden Follow-ups

## nginx /api/youtube-feed cache zone (queued 2026-04-19)

**Problem:** `/api/youtube-feed` proxies to YouTube's RSS feed, which flaps 200/404/500 based on YouTube's rate-limiting of the server IP. The existing `proxy_cache_valid 200 1h` in `nginx.conf` is a no-op — no `proxy_cache_path` zone is declared anywhere, so nothing actually caches. Every request hits YouTube live; when YouTube hiccups, the feed breaks for users and the smoke test logs `FAIL`.

**Current workaround:** smoke-test.sh now retries 3× with 2s backoff (shipped 2026-04-19), which absorbs smoke-test-side flaps. Real browsers still hit live YouTube with no fallback.

**Proper fix:**

1. In `nginx-main.conf`, inside the `http {}` block:
   ```
   proxy_cache_path /var/cache/nginx/youtube levels=1:2
       keys_zone=youtube_feed:1m max_size=10m inactive=24h use_temp_path=off;
   ```

2. In `nginx.conf`, inside the `location = /api/youtube-feed { ... }` block, add:
   ```
   proxy_cache youtube_feed;
   proxy_cache_key "youtube-feed";
   proxy_cache_lock on;
   proxy_cache_use_stale error timeout updating http_404 http_500 http_502 http_503 http_504 http_429;
   proxy_connect_timeout 5s;
   proxy_read_timeout 10s;
   proxy_set_header User-Agent "Mozilla/5.0 (compatible; NamiBardenSite/1.0)";
   ```
   (Keep the existing `proxy_cache_valid 200 1h;` line.)

3. Deploy: `cd /projects/NamiBarden && docker-compose build && docker-compose up -d`

4. Verify: hit `/api/youtube-feed` 5–10 times over a minute; all should return 200 even if YouTube briefly 404s/500s.

**Why deferred:** smoke-test retry already stops the alert. This is resilience polish — users rarely notice a broken YouTube widget — so it can ride the next NamiBarden rebuild instead of triggering a one-off build tonight.
