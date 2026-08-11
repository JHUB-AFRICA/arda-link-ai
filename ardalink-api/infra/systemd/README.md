# ArdaLink — non-Docker systemd deploy

Templated systemd **user** units for running `ardalink-api` and
`ardalink-engine` directly on a host (laptop or VPS) without Docker,
plus the reverse-SSH-tunnel unit used when the api is hosted somewhere
without a public IP of its own (e.g. behind NAT/CGNAT, or a personal
laptop) and needs a permanent public webhook URL anyway.

**Added 2026-08-11 (deployment audit)**: these three units were
running real production WhatsApp traffic on the original dev machine
but existed only as hand-edited files under
`~/.config/systemd/user/` — nowhere in the repo, so a handover meant
reverse-engineering them from `../../Arda-link-AI-Docs/deployment.md`'s
prose description rather than copying a tracked file. `deployment.md`
remains the source of truth for *when* to use this path vs. the
Docker stack (`../docker/`) — see its "Scenario 1/2" sections — this
directory is just the actual, copy-pasteable artifacts.

## When to use this vs. `../docker/`

Use the Docker stack (`../docker/RUNBOOK.md`) unless you specifically
need `ardalink-api`/`ardalink-engine` running as native processes —
e.g. matching the exact hybrid setup `deployment.md` describes as
currently live (self-hosted WhatsApp bridge on a VPS, api on a
personal machine reached via reverse tunnel), or any other case where
running outside a container is a deliberate choice, not a default.

## Install

1. Copy the two service units you need into `~/.config/systemd/user/`
   (`ardalink-tunnel.service` only applies if you actually need a
   reverse tunnel — most real deployments won't):
   ```bash
   mkdir -p ~/.config/systemd/user
   cp ardalink-api.service ardalink-engine.service ~/.config/systemd/user/
   ```
2. Replace every `<PLACEHOLDER>` in the copied files — each unit's own
   comments explain what belongs there. At minimum: `<ABS_PATH_TO_REPO>`,
   the language runtime `PATH` entries, and (api only) the three
   `.env.local`-related paths.
3. Make sure the real `.env.local` each unit reads actually exists
   with real secrets filled in (see `../docker/.env.example` for the
   full variable list — same variables, just consumed via `.env.local`
   + systemd here instead of Docker Compose's `environment:` block).
4. Enable and start:
   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now ardalink-api.service ardalink-engine.service
   # only if you need the tunnel:
   systemctl --user enable --now ardalink-tunnel.service
   ```
5. `systemctl --user status ardalink-api.service` /
   `journalctl --user -u ardalink-api.service -f` to confirm it's
   actually up — same health-check endpoints as the Docker path
   (`GET /api/healthz`, `GET :5001/health`).

**User (not system) units, deliberately** — matches the original
setup: no root required, tied to a logged-in user session (add
`loginctl enable-linger <user>` if this needs to survive logout /
run before login on a headless host).

**Schema setup is not covered here** — these units only run the app
processes. Create the database schema first via the same migrations
`../docker/RUNBOOK.md` documents (`docs/local-dev/migrations/*.up.sql`,
plus the Supabase-only ones if using a real Supabase project) — there's
no Docker-specific dependency in either the migration files or
`docs/local-dev/scripts/start-local.sh`'s approach, just point `psql`
at whatever Postgres these units' `.env.local` actually points at.
