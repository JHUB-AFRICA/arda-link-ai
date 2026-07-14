# Security Policy — ArdaLink monorepo

## Reporting a vulnerability

Email **security@ardalink.local** (or open a [private security advisory](https://github.com/JHUB-AFRICA/arda-link-ai/security/advisories/new) on GitHub).
Do **not** file a public issue.

We acknowledge within 48h and triage within 5 working days.

## Supported versions

| Version | Supported |
|---|---|
| `v0.1.0-pilot` and later | ✅ active |
| `< v0.1.0` | ❌ retired — please upgrade |

## Secret handling

**Never commit credentials.** Real production keys live in
`ardalink-api/.env.local` and `ardalink-engine/.env.local` (both
gitignored). On a fresh checkout, copy the matching `.env.example` to
`.env.local` and fill in your own values.

If a key is accidentally committed, treat it as compromised:

1. **Rotate the key** at the provider console immediately
   (don't wait for the PR to merge).
2. **Revoke the old key** even if you also rotated it.
3. **Audit usage** in the provider's activity log for the time the
   secret was in git history.
4. **Force-push** the cleaned history (or use `git filter-repo`) and
   notify all collaborators to re-clone.

### Current key inventory (as of `v0.1.0-pilot-2026-07-14`)

| Service | Variable | Rotation cadence |
|---|---|---|
| Azure OpenAI | `AZURE_OPENAI_API_KEY` | 90 days |
| Azure Speech (primary) | `AZURE_SPEECH_KEY` | 180 days |
| Azure Speech (secondary) | `AZURE_SPEECH_KEY_SECONDARY` | 180 days |
| Africa's Talking | `AFRICASTALKING_API_KEY` | 90 days |
| Google Cloud (GEE) | `GOOGLE_SERVICE_ACCOUNT_JSON` | 90 days |
| Supabase | `SUPABASE_SECRET_KEY` | 90 days |

Use a password manager (1Password, Bitwarden) for storage, not plaintext files.

## CI safety net

- **gitleaks** runs on every push to master/staging/dev and on every
  PR. A leak fails the build (no `continue-on-error`).
- **pip-audit** runs on every engine build; known CVEs fail the build.
- **Branch protection** (recommended): require 1 review + green CI
  on `master`, `staging`, `dev`. See `RUNBOOK.md`.

## Threat model (summary)

- All public routes (`/api/demo/*`, `/api/speech/token`, `/api/healthz`)
  are rate-limited at the API layer.
- WebSocket upgrades (`/api/voice-stream`, `/api/browser-voice-stream`)
  are authenticated.
- The Dashboard is JWT-bearer-only; tenant claim bound to the Postgres
  session so RLS enforces multi-tenant isolation.
- Cross-service attestation: API → engine with HMAC-SHA256
  (`TENANT_ATTESTATION_SECRET`).
- Africa's Talking callback endpoints are signature-verified.

Per-service details in `ardalink-{api,engine,web}/SECURITY.md` and
`Arda-link-AI-Docs/security.md`.
