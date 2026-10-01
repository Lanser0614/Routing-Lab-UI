#!/bin/sh
set -eu
cd /app
umask 077
if [ ! -f /app/.env ]; then
  cp /app/config/.env.default /app/.env
  echo 'Created /app/.env. Edit with: docker exec -it routing-lab vi /app/.env'
fi
node /app/docker/initialize.js
exec "$@"
