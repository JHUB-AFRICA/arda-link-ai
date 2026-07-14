# Contributing to ArdaLink Web

## Development setup

- Node 24+
- pnpm 9

```bash
git clone git@github.com:JHUB-AFRICA/arda-link-ai.git
cd ardalink-web
pnpm install
pnpm --filter dashboard run dev
```

## Workflow

1. Branch off `dev`
2. Conventional Commits
3. Pre-commit: `pnpm exec prettier --check .`
4. Tests: `pnpm test`
5. PR against `dev`

## Code style

- React 19 + Vite
- Tailwind v4
- TanStack Query for server state
- Wouter for routing
- TypeScript strict mode

## Testing

- Vitest + Testing Library
- Coverage floor 60%

## Security

See [SECURITY.md](SECURITY.md).
