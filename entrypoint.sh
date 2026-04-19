#!/bin/sh
set -e

# Ensure nginx can read all static files (guards against broken perms from docker cp)
chmod -R a+rX /usr/share/nginx/html

# Start nginx in background
nginx -g 'daemon off;' &

# Start Node.js server
exec node server.js
