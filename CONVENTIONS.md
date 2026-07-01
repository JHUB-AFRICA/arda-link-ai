# Code Conventions

This document is the **shared standard** for every service in this monorepo.
Each service has a sibling `CONVENTIONS.md` with language-specific addenda:

- [`ardalink-api/docs/CONVENTIONS.md`](./ardalink-api/docs/CONVENTIONS.md) — TypeScript / Node 24 / Express
- [`ardalink-engine/docs/CONVENTIONS.md`](./ardalink-engine/docs/CONVENTIONS.md) — Python 3.12 / FastAPI
- [`ardalink-web/docs/CONVENTIONS.md`](./ardalink-web/docs/CONVENTIONS.md) — TypeScript / React 19

If a per-service doc contradicts this one, the per-service doc wins **only** when
it is explicit about the override. Otherwise this document is authoritative.

---

## 1. Scope

This standard covers:

- File organisation and naming
- When to split a module
- Module-level, function-level, and type-level documentation
- Comment hygiene
- Per-module `README.md` requirements

It does **not** cover:

- Formatting (use the existing Prettier / Black / Ruff configs)
- Linting rules (use the existing ESLint / Ruff configs)
- Testing strategy (see each service's runbook)

---

## 2. The hybrid documentation standard

We document at the **lowest level that still answers every plausible reader
question**, and no lower. This gives us coverage where it matters and silence
where the code already speaks for itself.

| Level | Required for | Purpose |
|---|---|---|
| **Module docstring** | Every non-trivial source file (≥ 10 LOC) | What this module answers, what's exported, what it depends on, what side effects it has. |
| **Function docstring** | Public exports **AND** any function with branching / I/O / side effects / non-obvious behaviour | What the function does, what it takes, what it returns, what it throws. |
| **Type doc** | Every exported interface / type alias | What instances of this type represent, what each field means, units if not obvious. |
| **Inline comment** | "Why" only — never "what" | Workarounds, surprising behaviour, references to external specs. |
| **Module `README.md`** | Modules with ≥ 5 files **or** that form a domain | Purpose, architecture, key concepts, usage example. |

A function is "trivial" — and therefore exempt from function-level docs — when
**all** of these hold:

- ≤ 5 lines of body
- No branching, no async, no I/O
- Name and signature already make intent obvious
- No side effects

If you're not sure whether a function is trivial, document it.

---

## 3. File organisation

### 3.1 One concern per file

A file should answer **one question** and answer it well. If your module
documentation needs the word "and" twice, it is two modules.

Signals that a file is mixing concerns:

- Its exported names fall into unrelated noun groups (e.g. `computeDrought` and
  `validatePhone`).
- Editing one function requires a reviewer to scroll past unrelated code.
- The file is the only one that imports two unrelated domain types.

### 3.2 When to split

A file longer than **300 lines of source** triggers a split review. A file
longer than **500 lines** must be split before merge unless the PR description
explicitly justifies the size.

### 3.3 Naming

| Language | Module file | Type / class | Component | Constant |
|---|---|---|---|---|
| TypeScript | `kebab-case.ts` | `PascalCase` | `PascalCase.tsx` | `SCREAMING_SNAKE_CASE` |
| Python | `snake_case.py` | `PascalCase` | n/a | `SCREAMING_SNAKE_CASE` |

Directory names match the dominant file style inside them: `lib/forecast/`,
`components/Choropleth/`, `pipeline/grid_ingest/`.

### 3.4 Index files

A directory's public surface is exposed via `index.ts` (TS) or `__init__.py`
(Python). Internal modules are imported via their explicit path — never rely
on barrel re-exports for internal use.

---

## 4. Module-level documentation

Every source file (≥ 10 LOC) starts with a docstring covering, in this order:

1. **Purpose** — one or two sentences naming the question this module answers.
2. **Public surface** — what it exports and what each export is for.
3. **Dependencies** — what it imports and any non-obvious assumptions.
4. **Side effects** — I/O, clock, randomness, mutation of inputs, environment
   reads, network calls. If there are none, say "Pure module — no side effects."

### TypeScript example

```ts
/**
 * droughtScoring — convert a climate window + vegetation anomaly into a
 * pastoralist-facing drought severity grade.
 *
 * Public surface:
 *   - {@link scoreDrought}     — the main scoring function
 *   - {@link DroughtGrade}     — output type
 *   - {@link gradeToSwahili}   — translation helper for the SMS / voice channel
 *
 * Depends on: {@link HistoricalClimateWindow}, {@link VegetationAnomaly}.
 *
 * Pure module — no I/O, no clock, no randomness. Safe to call from request
 * handlers without memoisation.
 */
```

### Python example

```py
"""drought_scoring — convert a climate window + vegetation anomaly into a
pastoralist-facing drought severity grade.

Public surface
--------------
score_drought(climate, anomaly) -> DroughtGrade
    The main scoring function.
DroughtGrade
    Output type (Pydantic model).
grade_to_swahili(grade, lang) -> str
    Translation helper for the SMS / voice channel.

Depends on
----------
- HistoricalClimateWindow, VegetationAnomaly (from ..types)

Pure module — no I/O, no clock, no randomness. Safe to call from request
handlers without memoisation.
"""
```

---

## 5. Function-level documentation

Required for any function that is **exported** OR has **branching / I/O /
side effects / non-obvious behaviour**. The standard form is:

### TypeScript

```ts
/**
 * Fetch the current drought score for a tenant's home ward.
 *
 * Reads the latest cached climate window from Redis. On cache miss it
 * re-fetches from Open-Meteo and writes back. Result is cached for 15
 * minutes per (tenant, ward).
 *
 * @param tenantId  Tenant ID — must be one of the seeded wards.
 * @returns         The current {@link DroughtScore}, or `null` if upstream
 *                  Open-Meteo is unreachable and no cache exists.
 * @throws          Never — upstream errors degrade to `null`.
 */
export async function fetchDroughtScore(tenantId: string): Promise<DroughtScore | null>
```

### Python

```py
def fetch_drought_score(tenant_id: str) -> DroughtScore | None:
    """Fetch the current drought score for a tenant's home ward.

    Reads the latest cached climate window from Redis. On cache miss it
    re-fetches from Open-Meteo and writes back. Result is cached for 15
    minutes per (tenant, ward).

    Parameters
    ----------
    tenant_id : str
        Tenant ID — must be one of the seeded wards.

    Returns
    -------
    DroughtScore | None
        The current score, or ``None`` if upstream Open-Meteo is unreachable
        and no cache exists.

    Raises
    ------
    Nothing. Upstream errors degrade to ``None``.
    """
```

Use `@example` (TS) or an `Example` block (Py) only when usage is genuinely
non-obvious — for instance, a function that requires a specific call order
with another helper.

---

## 6. Type-level documentation

Every exported interface, type alias, or Pydantic model gets:

- A one-line summary on the declaration itself.
- A docstring on every field that isn't obvious from name + type.

```ts
/** Pastoralist's herd composition, as reported via SMS or the operator dashboard. */
export interface HerdComposition {
  /** Head of cattle. 0 if unknown or not owned. */
  cattle: number;
  /** Small ruminants (sheep + goats combined). */
  smallRuminants: number;
  /** Camels. Optional — many herders don't keep camels. */
  camels?: number;
  /** ISO 8601 timestamp the herder reported this composition. */
  reportedAt: string;
}
```

---

## 7. Comment hygiene

The two rules:

1. **Comment the "why", never the "what".** If the code already says what it
   does, the comment is noise.
2. **Use marker tags consistently** for things that need to be revisited.

### Marker tags

| Tag | Meaning | Required follow-up |
|---|---|---|
| `TODO:` | Planned but not started. | Linked issue or `owner:` name. |
| `FIXME:` | Known broken or fragile. | Linked issue. |
| `HACK:` | Works but for unsavoury reasons — must be revisited before non-dev use. | Linked issue + owner. |
| `NOTE:` | Insight that prevents a future reader from "fixing" something correct. | None. |
| `SPEC:` | Reference to an external specification the code implements. | URL. |

Place markers on the line immediately above the relevant code, not trailing:

```ts
// SPEC: https://datatracker.ietf.org/doc/html/rfc7231#section-4.3.1
// We accept bodies on GET for compatibility with the legacy SMS gateway.
if (req.method === "GET" && req.body) { ... }
```

Do **not** narrate obvious code:

```ts
// ❌ Bad — the code already says this
i++; // increment i

// ✅ Good — explains a non-obvious decision
i++; // skip the sentinel; upstream never sends it
```

---

## 8. Per-module `README.md`

A module needs a `README.md` when it satisfies **either**:

- Contains ≥ 5 files, OR
- Forms a domain (e.g. `lib/openData/`, `lib/voice/`, `pipeline/`).

The README structure:

```md
# <Module Name>

<One-paragraph purpose: what question this module answers.>

## Architecture

<Short prose or a tiny ASCII diagram of how the files fit together.>

## Public API

<Bullet list of the most important exports with one-line descriptions.>

## Usage example

<10–20 lines of real, copy-pasteable usage.>

## Dependencies

<What this module pulls in — explicit, not transitive.>

## Tests

<Where the tests live and what coverage exists.>
```

Keep it under ~150 lines. A README that needs to be longer is a sign the
module should be split.

---

## 9. Verification & enforcement

### 9.1 In PRs

Each PR template must include:

> - [ ] I have read `CONVENTIONS.md` and the relevant service addendum.
> - [ ] No new file exceeds 500 lines unless justified in the PR description.
> - [ ] New modules have module-level documentation.
> - [ ] New public functions have function-level documentation.

### 9.2 In tooling

| Tool | Purpose | Threshold |
|---|---|---|
| `eslint` + `eslint-plugin-import` (TS) | Module boundaries, unused exports | Warning at > 10 unused exports |
| `knip` (TS) | Dead code, unused files | Report-only, no block |
| `vulture` (Python) | Dead code | Confidence ≥ 60% reported in CI |
| `interrogate` (Python) | Docstring coverage | ≥ 80% on `ardalink_engine/` |
| `actionlint` (YAML) | Workflow syntax | Block on error |

### 9.3 In review

Reviewers are explicitly empowered to request a split or docs addition without
the author needing to "earn" the comment. "This module is too big" or "Please
add a function doc" is a complete review comment.

---

## 10. Versioning

This document is versioned with the repo. Changes follow the same review
process as code changes. When updating:

- Add a one-line note at the top summarising the change.
- Update any per-service addenda that reference the changed section.