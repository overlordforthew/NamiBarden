#!/bin/sh
set -e

# Start nginx in background
nginx -g 'daemon off;' &

# Start Node.js server
exec node server.js
