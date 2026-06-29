# 04 — Security

[← Deployment](03-DEPLOYMENT.md) · [Next: Observability →](05-OBSERVABILITY.md)

## Threat model (summary)

| Surface                   | Threat                   | Control                        |
| ------------------------- | ------------------------ | ------------------------------ |
| WebSocket upgrades        | Hijack, denial-of-wallet | JWT auth (Phase 8)             |
| Africa's Talking callback | Forged call events       | HMAC verify (Phase 8)          |
| Azure OpenAI key          | Token theft              | Cloud secret manager (Phase 8) |
| Ground truth DB           | Cross-tenant leak        | Row-level security (Phase 2)   |

## Secrets

- `.env.example` only in git
- `gitleaks` pre-commit
- Production secrets in cloud secret manager (Phase 8)

Full threat model migrates from legacy in Phase 7.
