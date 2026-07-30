# 06 — Costs

[← Observability](05-OBSERVABILITY.md) · [Next: Runbooks →](07-RUNBOOKS.md)

## Primary cost drivers (this service)

| Driver                | Pricing model    | Pilot impact                            |
| --------------------- | ---------------- | --------------------------------------- |
| Azure OpenAI Realtime | per-minute audio | Largest single line item                |
| Azure OpenAI GPT-4o   | per-token        | Script composition + transcript tagging |
| Africa's Talking      | per-minute voice | Outbound + recording                    |
| Supabase              | free tier → pro  | Baselines + ward data + call records    |
| Compute (Express)     | per-pod-hour     | Trivial at pilot scale                  |

Detailed cost model migrates from legacy `biophysical-engine/docs/COSTS.md` in Phase 7.
