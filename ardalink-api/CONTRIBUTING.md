# Contributing to ArdaLink API

Thanks for your interest.

## Development setup

- Node 24+
- pnpm 9
- PostgreSQL 14+

```bash
git clone git@github.com:JHUB-AFRICA/arda-link-ai.git
cd ardalink-api
pnpm install
cp .env.example .env
pnpm run dev
```

## Workflow

1. Branch off `dev`: `git switch -c feat/<short-name>`
2. Conventional Commits (see `.commitlintrc.yml`)
3. Run pre-commit hooks: `pnpm exec pre-commit run --all-files`
4. Run tests: `pnpm test`
5. Open a PR against `dev`

## Code style

- TypeScript strict mode
- ESLint + Prettier (enforced by CI)
- Public route handlers validate inputs with Zod (generated from `lib/api-spec/openapi.yaml`)

## Testing

- Unit tests with vitest, coverage floor 60%
- Integration tests against Postgres (compose service)
- Contract tests against `ardalink-engine`

## Security

See [SECURITY.md](SECURITY.md).
