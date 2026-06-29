# 03 — Deployment

[← API](02-API.md) · [Next: Security →](04-SECURITY.md)

## Local

```bash
pnpm install
cp .env.example .env
pnpm --filter dashboard run dev    # 5173
pnpm --filter talk run dev         # 5174
```

## Production build

```bash
pnpm run build
# outputs:
#   dashboard/dist/
#   talk/dist/
```

Static assets served via Caddy (see `infra/docker/compose.yml` in ardalink-api).
