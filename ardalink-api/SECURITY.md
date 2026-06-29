# Security Policy

## Reporting a vulnerability

Email **security@ardalink.local** (or open a private security advisory on GitHub).
Do **not** file a public issue.

## Threat model (summary)

- WebSocket upgrades (`/api/voice-stream`, `/api/browser-voice-stream`) must be authenticated.
- Africa's Talking callbacks (`/api/voice-callback`) must verify HMAC signature.
- Voice transcripts contain PII — encrypted at rest, retention-bounded.
- Cosmos DB primary key + Azure OpenAI key never reach client code.

Full threat model migrates from legacy docs in Phase 7.
