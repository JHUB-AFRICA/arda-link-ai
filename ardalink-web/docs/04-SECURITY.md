# 04 — Security

[← Deployment](03-DEPLOYMENT.md) · [Next: Observability →](05-OBSERVABILITY.md)

## Threat model

| Surface                | Threat                 | Control                                          |
| ---------------------- | ---------------------- | ------------------------------------------------ |
| Realtime ephemeral key | Token theft            | Short TTL, scoped to single call (Phase 8)       |
| Microphone capture     | Unauthorized recording | Explicit user consent UI                         |
| Local storage          | Token persistence      | httpOnly cookies for session, never localStorage |

## Secrets

Browser-side env vars prefixed `VITE_` are **public** at build time.
Never put real secrets in `VITE_*` variables.
