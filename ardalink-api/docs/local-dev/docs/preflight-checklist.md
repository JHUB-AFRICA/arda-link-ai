# Tuesday Pre-Flight Checklist

**Date**: 2026-06-23 (Tuesday) · **Time**: 09:00 · **Box**: this dev machine
**Lead**: Denis Munene Ndegwa (Lead Software Engineer) · **Escalation**: Simon (on call)

---

## Sunday night (EOD) — run before signing off

- [ ] **Run the full verification**:
  ```bash
  bash hardening/scripts/verify.sh
  ```
  Expected: `READY: N/N passed (0 warnings)` at the end.

- [ ] **Bring the local stack up** so it's already running Tuesday morning:
  ```bash
  bash hardening/scripts/start-local.sh
  ```
  Expected: stack boots in ~90s, prints demo JWTs at the end.

- [ ] **Smoke test the demo flow once** by following the walkthrough
  (`hardening/docs/walkthrough.md`). This catches any drift between
  what the script says and what the UI shows.

- [ ] **Verify the browser opens the dashboard cleanly**:
  - `http://localhost:8080/` — operator dashboard
  - `http://localhost:8080/talk/` — public Talk app
  - Login not required for the local demo (no real auth UI; JWT is
    injected programmatically)

- [ ] **Confirm the backup is intact** (recovery source if anything
  goes catastrophically wrong):
  ```bash
  ls -la ~/ardalink-backups/ardalink-pre-restructure-20260621T194026Z.tar.gz
  sha256sum ~/ardalink-backups/ardalink-pre-restructure-20260621T194026Z.tar.gz
  ```
  Expected: 34 MB file, SHA-256 starts with `0c94bca6`.

- [ ] **Check the team has seen the PRs**. The three migration PRs are
  the source of truth for the architecture:
  - `MUNENE1212/ardalink-engine` — pull/7
  - `MUNENE1212/ardalink-api`    — pull/8
  - `MUNENE1212/ardalink-web`    — pull/7

- [ ] **Verify the email to Simon has been sent**. He is the
  escalation path if anything goes wrong during the session.

---

## Monday morning (if anything needs attention)

- [ ] Check Simon's reply (rare; he's traveling Tuesday)
- [ ] Triage any PR comments that came in over the weekend
- [ ] If `verify.sh` failed, fix and re-run

---

## Tuesday 08:30 (90 min before session)

- [ ] **Open the terminal** and confirm the stack is still up:
  ```bash
  bash hardening/scripts/verify.sh
  ```
  If the stack is down for any reason:
  ```bash
  bash hardening/scripts/start-local.sh
  ```

- [ ] **Open the browser tabs** in advance:
  - `http://localhost:8080/` (dashboard)
  - `http://localhost:8080/talk/` (Talk)
  - `https://github.com/MUNENE1212/ardalink-api/pull/8` (PR for live reference)
  - `hardening/docs/walkthrough.md` (in your editor)

- [ ] **Confirm the projector / screen share works** (if presenting in
  a meeting room rather than 1:1).

---

## Tuesday 09:00 — session starts

Follow `hardening/docs/walkthrough.md` end to end.

---

## Tuesday 10:00 — session ends

- [ ] Capture action items in `hardening/docs/action-items-2026-06-23.md`
- [ ] Send a 3-line summary to Simon and the team channel
- [ ] Leave the stack running for 24 hours in case anyone wants to
  poke at it post-session
- [ ] Tuesday EOD: `bash hardening/scripts/stop-local.sh` (or leave
  up until next session)

---

## If something goes really wrong

1. **Stop the demo politely** — "Let me show you a different angle
   while I check the logs."
2. **`tail -50 /tmp/ardalink-local/api.log`** (or engine.log, web.log)
3. **If restart is needed**: `bash hardening/scripts/stop-local.sh`
   then `bash hardening/scripts/start-local.sh`
4. **If the data is corrupt**: drop and re-seed (see
   `hardening/docs/RECOVERY.md` — written Monday if needed)
5. **If the network is down**: terminal-only demo of the database
   queries and the verify script output

The backup is at `~/ardalink-backups/` with documented restore
procedure. Worst case, full recovery is a 5-minute `git clone` from
the bundles.

---

## What is NOT in scope for Tuesday

- Production deploy
- Real Africa's Talking call (sandbox only)
- Live GEE data (we use cached baseline numbers in the demo)
- Real Azure OpenAI calls (we use deterministic scripts in the demo)
- Any irreversible change to `main` on GitHub

The demo is **read-only with respect to production state**. Every change
is local to this machine.