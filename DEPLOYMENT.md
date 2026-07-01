# Enterprise deployment guide (Linux + Docker + TLS)

This file explains how to take the Generic ERP Platform from a working dev
container (`pnpm dev:api && pnpm dev:web`) to a production deployment suitable
for paying customers.

## TL;DR

```bash
cp .env.example .env
# Edit .env — set JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, SMTP_* etc.
docker compose up -d db
docker compose run --rm api pnpm --filter @erp/api db:migrate
docker compose run --rm api pnpm --filter @erp/api db:seed
docker compose up -d api web
```

Browse:
- App:    http://localhost:5173
- API:    http://localhost:3000/api/v1
- Docs:   http://localhost:3000/api/docs
- Adminer (dev only): http://localhost:8080

Default credentials seeded:
- Organization: `DEMO`
- Email:        `admin@demo.test`
- Password:     `Admin@123`

## Production checklist

- [ ] Strong JWT secrets (32+ random chars). The API refuses to start with weak secrets.
- [ ] TLS termination (Caddy / nginx / a load balancer).
- [ ] Postgres backups (pg_dump cron + offsite copy).
- [ ] SMTP provider configured (otherwise password-reset emails won't send).
- [ ] `STORAGE_DRIVER=s3` + AWS credentials when you outgrow local disk.
- [ ] `ThrottlerModule` is registered globally — verify by hitting login 100×.
- [ ] `JWT_ACCESS_SECRET` rotated quarterly (re-encrypt User.mfaSecret rows).
- [ ] Run `pnpm verify` in CI before every release.

## Observability

- `GET /api/v1/health`           — liveness
- `GET /api/v1/health/ready`     — readiness (DB ping)
- `GET /api/v1/health/startup`   — startup
- `GET /api/v1/metrics`          — Prometheus text format
- Pino structured logs to stdout — pipe to Loki / Datadog / CloudWatch.

## Multi-instance

The outbox worker uses Postgres advisory locks (`SKIP LOCKED`) and a claim
token so multiple API replicas can run safely. Webhooks + recurring generator
+ notifications use the same lock pattern.

Set `OUTBOX_POLL_MS=2000` and run at least 2 replicas.

## Backups

A nightly `pg_dump` is the minimum. Enable point-in-time recovery (PITR) on
the Postgres cluster for safety against accidental writes. Test the restore
process quarterly.
