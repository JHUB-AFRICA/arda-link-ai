# 01 — Architecture

[← Executive Index](00-EXECUTIVE-INDEX.md) · [Next: API →](02-API.md)

## At a glance

```
ardalink-api (REST + WS) ──► ardalink-web (browser)
                                 │
                                 ├── dashboard/ (operator UI)
                                 └── talk/ (public voice + chat)
```

- Both apps use **TanStack Query** for server state, **Wouter** for routing,
  **Tailwind v4** for styling, and **Framer Motion** for animation.
- API hooks are **generated from ardalink-api OpenAPI** (Phase 3).
- The Realtime API for browser voice is reached through `ardalink-api`'s
  `/api/browser-voice-stream` WebSocket.
