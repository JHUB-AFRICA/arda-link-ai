<div align="center">

# ArdaLink Web

### Operator dashboard and public Talk voice app

ArdaLink Web hosts the two user-facing surfaces: an operator dashboard for
monitoring drought status and herder ground truth, and a public Talk app
that lets anyone converse with ArdaLink in their browser.

[![Node](https://img.shields.io/badge/Node-24-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![React](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![pnpm](https://img.shields.io/badge/pnpm-workspaces-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

</div>

---

## Quickstart

```bash
# Requires Node 24 and pnpm 9
pnpm install
cp .env.example .env          # edit
pnpm --filter dashboard run dev    # http://localhost:5173
pnpm --filter talk run dev         # http://localhost:5174
```

Both apps read their OpenAPI hooks from
[`ardalink-api/lib/api-spec/openapi.yaml`](../ardalink-api/lib/api-spec/openapi.yaml)
inside this same monorepo.

---

## What's in here

| App                    | Path         | Audience                                               |
| ---------------------- | ------------ | ------------------------------------------------------ |
| **Operator dashboard** | `dashboard/` | Internal — drought status, ground truth, call controls |
| **Public Talk**        | `talk/`      | Anyone — browser voice + chat, no phone required       |
| **Shared hooks**       | `packages/api-client-react/` | Typed React Query hooks used by both apps |

## Repository layout

```
ardalink-web/
├── dashboard/                       React 19 + Vite + Tailwind
│   ├── src/
│   │   ├── components/              WardMapLive, CallModal, CostRailsCard
│   │   ├── pages/                   dashboard, call-receiver
│   │   └── lib/                     browserVoice bridge
│   ├── tests/                       vitest (auth gate, login, intelligence brief, mint-call-token, tenant)
│   └── vite.config.ts
├── talk/                            React 19 + Vite + Tailwind
│   ├── src/
│   │   ├── components/              ChatPanel, EnvPanel
│   │   ├── lib/                     phone, consent, voiceState (pure helpers, tested)
│   │   └── pages/                   Home (single-screen flow)
│   ├── tests/                       vitest (phone normalisation, consent state, voice state machine, tenant)
│   └── vite.config.ts
├── packages/
│   └── api-client-react/            Typed hooks: useGetStatus, useListPastoralists, mintCallToken, …
│       ├── src/                     813 LOC single curated file
│       ├── tests/                   vitest (apiFetch Bearer, getToken URL-hash, error surfacing)
│       └── README.md
├── docs/                            8-doc CTO navigation
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
└── package.json
```

---

## Documentation

Start with [`docs/00-EXECUTIVE-INDEX.md`](docs/00-EXECUTIVE-INDEX.md) (5 min).

For the shared API hooks package, see
[`packages/api-client-react/README.md`](packages/api-client-react/README.md).

---

## Sister services (same monorepo)

- [`ardalink-api/`](../ardalink-api/) — backend + voice bridge
- [`ardalink-engine/`](../ardalink-engine/) — biophysical brain

---

## License

[MIT](../../LICENSE) — Copyright (c) 2026 ArdaLink.