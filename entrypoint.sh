#!/bin/sh
set -e

# Ensure nginx (uid 100) can read all static files. Guards against broken
# perms from docker cp or editors that save files with 640.
find /usr/share/nginx/html -type d -exec chmod 755 {} +
find /usr/share/nginx/html -type f -exec chmod 644 {} +

# Start nginx in background
nginx -g 'daemon off;' &

# Start Node.js server
exec node server.js
