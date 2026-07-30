# ArdaLink AI — WhatsApp Delivery Approach (Research)

> **Status**: research / not yet built. ArdaLink's herder-facing channels today are voice, USSD, and SMS via Africa's Talking (see [`voice.md`](./voice.md)) — all chosen because they work on 2G feature phones with no app install. This doc evaluates whether and how to add WhatsApp as an **additional** channel, and which delivery approach to build it on. It does not replace the voice/USSD/SMS-first architecture; WhatsApp is being scoped as a channel for smartphone-equipped herders, cooperative representatives, and the operator side (brief delivery, PDF export), per [`STATUS.md`](../STATUS.md) §6.5.

---

## Table of Contents

1. [Why WhatsApp, and why not yet default](#why-whatsapp-and-why-not-yet-default)
2. [Delivery approaches compared](#delivery-approaches-compared)
3. [Option A — Meta Cloud API direct](#option-a--meta-cloud-api-direct)
4. [Option B — BSP (Twilio / 360dialog / similar)](#option-b--bsp-twilio--360dialog--similar)
5. [Option C — Self-hosted: Evolution API](#option-c--self-hosted-evolution-api)
6. [Option D — Self-hosted: OpenClaw](#option-d--self-hosted-openclaw)
7. [Compliance: Meta's 2026 AI-chatbot policy](#compliance-metas-2026-ai-chatbot-policy)
8. [Recommendation](#recommendation)

---

## Why WhatsApp, and why not yet default

WhatsApp is the dominant messaging app in Kenya among smartphone owners, and it would let ArdaLink send richer content than 160-character SMS — images (choropleth snapshot, water-point map), voice notes, and structured buttons/lists for the same category menu the USSD tree already offers. That's attractive for:

- **Cooperative reps / county extension officers** — smartphone-equipped, want the intelligence brief as a message they can forward, not a phone call.
- **Herders who already have a smartphone** — a subset of the Isiolo pilot population, not the majority. STATUS.md's own gap analysis puts **40% of Isiolo herders on feature phones**, which is why USSD/SMS fallback is rated "Important" risk-if-not-done.

WhatsApp requires a smartphone, a data connection, and the WhatsApp app installed — none of which are guaranteed for the core pastoralist user. So this is scoped as **channel #4, additive to voice/USSD/SMS**, not a replacement.

---

## Delivery approaches compared

| Approach | Official? | Ban risk | Cost model | Ops burden | Fit for ArdaLink |
|---|---|---|---|---|---|
| **A. Meta Cloud API direct** | ✅ Official | None | Free tier + per-conversation fee ($0.005–0.15/convo depending on country/category) | Medium — own webhook, template approval | Best long-run fit if volume justifies going direct |
| **B. BSP (360dialog, Twilio)** | ✅ Official, via partner | None | BSP platform fee (360dialog ~€49/mo zero markup; Twilio $0.005/msg platform fee) + Meta's per-conversation fee | Low — BSP handles number registration, template review | Fastest to a compliant pilot |
| **C. Evolution API (self-hosted)** | ⚠️ Unofficial by default (Baileys/WhatsApp Web protocol) or official (also supports Cloud API mode) | High on Baileys mode — WhatsApp can detect and ban automated Web-protocol accounts; near-zero if configured to use its official Cloud API mode instead | Infra only (~$5–20/mo VPS + Postgres + Redis) | Medium — you run and patch the service, own the ban risk | Good for internal dev/demo, risky for pilot-facing production unless run in Cloud-API mode |
| **D. OpenClaw (self-hosted)** | ⚠️ Unofficial (whatsapp-web.js) by default, official via a paid connector (e.g. Kapso) | Same class of risk as C in default mode | Free (MIT) + infra; paid if using an official-API connector | Low for a single internal number, not designed for outbound broadcast to thousands of herders | Wrong tool for herder delivery — it's an AI-agent-to-personal-WhatsApp gateway, not a business messaging platform. Could be useful internally (ops team chatting with an internal agent over WhatsApp), not for the pilot's outbound channel |

---

## Option A — Meta Cloud API direct

Meta's own WhatsApp Business Platform. You register a business, get a phone number ID, and call `graph.facebook.com/v.../messages` directly with your own access token.

- **Pros**: no middleman fee, full control over templates, direct relationship with Meta for policy/appeals.
- **Cons**: you own webhook infra, template submission/approval process, and rate-limit tier growth (starts capped at 250 unique conversations/24h on a new number, scales with quality rating).
- **Cost**: free service conversations in some categories; paid template-initiated conversations billed per-conversation, rate depends on destination country and category (marketing/utility/authentication/service).

## Option B — BSP (Twilio / 360dialog / similar)

A Business Solution Provider sits between you and Meta, handling number onboarding and template review, exposed as their own API.

- **360dialog**: ~€49/mo flat, no per-message markup on top of Meta's fee — cited as the cheapest BSP route for technically capable teams.
- **Twilio**: adds a flat ~$0.005 per message on top of Meta's fee, but integrates cleanly if the team is already comfortable with Twilio's SDKs (not currently the case here — ArdaLink's telephony stack is Africa's Talking, not Twilio).
- **Africa's Talking**: does not currently offer a WhatsApp Business API product (AT is SMS/voice/USSD-focused as of this research) — so picking a BSP means adding a second telephony vendor relationship, not extending the existing AT contract.

## Option C — Self-hosted: Evolution API

Open-source (Apache 2.0), Node/TypeScript/Express REST wrapper maintained by the Evolution Foundation. Two connection modes:

- **Baileys mode** (default, free): reverse-engineered WhatsApp Web protocol. No Meta approval needed, but the number risks a ban since it's outside Meta's sanctioned integration path.
- **Cloud API mode** (also supported): same REST wrapper, but backed by the official Meta Cloud API — removes the ban risk, keeps the self-hosted convenience layer (webhooks, Postgres/Redis-backed instance state, S3 media storage).

Docker image published as `evoapicloud/evolution-api`; requires Postgres/MySQL + Redis, fits ArdaLink's existing containerization pattern (multi-stage Dockerfiles already exist for api/web/engine).

**Relevance to ArdaLink**: if the team wants a self-hosted WhatsApp layer instead of paying a BSP monthly fee, Evolution API run in **Cloud API mode** is the credible option — same infra pattern as the rest of the stack, no added ban risk. Running it in Baileys mode against real herder numbers would be an unacceptable risk for a funded pilot.

## Option D — Self-hosted: OpenClaw

MIT-licensed self-hosted gateway that connects an AI coding/personal agent to chat apps (WhatsApp, Telegram, Discord, iMessage) via `whatsapp-web.js`, letting a person control an AI agent from their own WhatsApp thread. An official-API connector exists (e.g. via Kapso) to remove ban risk.

**Relevance to ArdaLink**: this solves a different problem — one person's phone driving an AI agent — not many-to-many outbound broadcast to a herder population. Not a fit for the pilot's delivery channel. Worth a mention only because it surfaced during research; not recommended for herder-facing work.

---

## Compliance: Meta's 2026 AI-chatbot policy

As of **2026-01-15**, Meta's updated WhatsApp Business terms bar **general-purpose AI chatbots** from the Business API, while explicitly permitting **business-specific bots** (customer support, order tracking, bookings, FAQs), under new pricing. ArdaLink's WhatsApp use case — livestock advisory replies, drought alerts, brief delivery — should be framed and configured as a **business-specific advisory bot**, not a general-purpose assistant, both in the template-message copy submitted for approval and in how the bot describes its own scope to the herder. This needs a policy read-through before submitting templates, regardless of which delivery approach (A–C) is chosen.

---

## Recommendation

For the MVP submission and near-term pilot:

1. **Don't build the herder-facing WhatsApp channel as the primary delivery path** — voice/USSD/SMS via Africa's Talking remains correct for the 2G/feature-phone majority of Isiolo herders.
2. **Scope WhatsApp first for cooperative reps / operator brief delivery** (a smaller, smartphone-guaranteed audience), where the win (rich content, forwardable briefs) is real and the ban/compliance risk is easiest to justify.
3. **Start with Option B (a BSP, likely 360dialog)** for the fastest compliant path to a working pilot — avoids owning template-approval and webhook plumbing during the exercise submission window.
4. **Revisit Option C (Evolution API, Cloud-API mode)** once volume or cost make a self-hosted layer worth the ops burden — it fits the existing Docker/Postgres/Redis pattern already used by `ardalink-api`.
5. **Do not use Baileys-mode self-hosting or OpenClaw for herder-facing delivery** — ban risk and wrong tool shape, respectively.

---

Sources consulted (2026-07):
- [Evolution API — GitHub](https://github.com/EvolutionAPI/evolution-api)
- [OpenClaw WhatsApp docs](https://openclaw.im/docs/channels/whatsapp)
- [OpenClaw + Kapso official WhatsApp connector](https://github.com/Enriquefft/openclaw-kapso-whatsapp)
- [360dialog vs Twilio vs Meta pricing comparison](https://ezcontact.ai/en/blog/whatsapp-api-pricing-comparison-meta-twilio-360dialog-ezcontact/)
- [WhatsApp Business API Africa 2026 setup guide](https://afrotools.com/blog/whatsapp-business-api-africa-2026/)
- [WhatsApp's 2026 AI rules — African commerce playbook](https://avodagroup.org/whatsapp-ai-rules-2026-african-commerce/)

*Research only — no code changes. Next step if approved: pick approach, register a BSP or Meta Business account, and land a `whatsapp.md` route + provider client in `ardalink-api/src/lib/` following the existing SMS (`routes/sms.ts`) pattern.*
