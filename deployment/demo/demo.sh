#!/usr/bin/env bash
# Demo stack lifecycle. Run from this directory on the host.
#   ./demo.sh up       build images, migrate + seed (first run), start, load activity
#   ./demo.sh update   rebuild images from the current source and restart (data kept)
#   ./demo.sh reset    wipe ALL demo data and re-seed
#   ./demo.sh activity post a fresh batch of demo sales
set -euo pipefail
cd "$(dirname "$0")"
dc() { docker compose --env-file .env "$@"; }

init_env() {
  [ -f .env ] && return
  # DEMO_ORIGIN is the URL clients type: https://demo.example.com behind a
  # reverse proxy, or http://<host ip>:8091 to serve straight from the port.
  : "${DEMO_ORIGIN:?first run: DEMO_ORIGIN=<public origin> ./demo.sh up}"
  umask 077
  {
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo "JWT_ACCESS_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
    echo "JWT_REFRESH_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
    echo "JWT_POS_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
    echo "METRICS_TOKEN=$(openssl rand -hex 24)"
    echo "CORS_ORIGINS=${DEMO_ORIGIN}"
    case "$DEMO_ORIGIN" in http://*) echo "WEB_BIND=0.0.0.0" ;; esac
    echo "DEMO_ADMIN_PASSWORD=admin"
  } > .env
  echo "wrote .env"
}

wait_api() {
  for _ in $(seq 1 60); do
    docker exec pd-api wget -qO- http://127.0.0.1:3000/api/v1/health/ready >/dev/null 2>&1 && return 0
    sleep 3
  done
  echo "API did not become ready" >&2; docker logs --tail 60 pd-api >&2; return 1
}

activity() { docker exec -i -e DEMO_ADMIN_PASSWORD="$(grep ^DEMO_ADMIN_PASSWORD= .env | cut -d= -f2-)" pd-api node --input-type=module - < demo-activity.mjs; }

seed_and_start() {
  dc up -d pd-db pd-redis
  dc --profile init run --rm pd-init
  dc up -d pd-api pd-web
  wait_api
  activity
}

case "${1:-}" in
  up)
    init_env
    # One image at a time: the host is shared, keep the build's memory peak low.
    dc --profile init build pd-init
    dc build pd-api
    dc build pd-web
    seed_and_start
    ;;
  update)
    dc build pd-api
    dc build pd-web
    dc up -d pd-api pd-web
    wait_api
    ;;
  reset)
    dc --profile init down -v
    seed_and_start
    ;;
  activity) activity ;;
  *) echo "usage: $0 up|update|reset|activity" >&2; exit 2 ;;
esac
