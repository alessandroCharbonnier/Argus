# Argus

Dependency-graph orchestrator for **Playwright E2E tests against a real staging
backend** — artifact hand-offs, an environment guard, and an
every-button-exercised gate.

Argus is a **thin scheduler over Playwright**, not a test engine. Playwright
owns execution, reporters, traces, and videos. Argus builds only what Playwright
cannot: the dependency graph, resource contracts, the environment guard,
critical/exclusive scheduling, and the element gate.

## Why

- **Safety first** — refuses to run against production. Before any reset or
  test, the target must return a **JSON environment marker** attesting both the
  app *and* the live database identity, compared field-by-field.
- **Deterministic order** — tests are nodes of a dependency graph
  (reset → seed → flows → teardown), with declared `reads`/`writes` so the
  scheduler never runs two writers of the same resource concurrently.
- **Every-button gate** — a crawler builds the denominator (all discoverable
  controls), a recorder of trusted (`isTrusted`) interactions builds the
  numerator; uncovered controls fail the gate unless excluded.

## Quickstart

```powershell
npm install
npx playwright install chromium
npm run build

# run the bundled demo end-to-end
npm run demo:e2e

# run your own plan
npx e2e-orchestrator run e2e-plan.yaml
```

Exit codes: `0` green · `1` red · `2` config · `3` invalid · `4` incomplete ·
`130` SIGINT.

## Repository layout

```
packages/orchestrator   @e2e-orchestrator/cli — plan parser, env guard,
                        scheduler, node runner, crawler, gate, reporting
packages/playwright     @e2e-orchestrator/playwright — test wrapper with the
                        recorder, publish()/grab() helpers, HTTP/console capture
examples/demo-app       Express + SQLite demo app, its e2e-plan.yaml, two specs
```

## Development

```powershell
npm run check        # typecheck + lint + format + tests
npm test             # vitest (sequential — NAS-safe)
npm run build        # tsc for all three packages
```

## Docs

- `PLAN.md` — full design, including the locked grilling decisions (§13)
- `docs/authoring.md` — writing specs/plans, written for agents and humans
- `docs/recipes.md` — reset patterns per backend stack
- `docs/oss-element-coverage-evaluation.md` — OSS landscape study (2026-11-18)
- `--print-schema` — the JSON Schema for `e2e-plan.yaml`

## Security model

The environment guard is the genuinely new part. See `PLAN.md` §5 for the full
story. In short: the app computes its `db` identity from its **live connection**
(a config label proves nothing); command resets are preceded by a read-only
`attest` over the same transport; the marker is re-checked on every drift poll.
Traces and artifacts can contain passwords — see the redaction note in
`docs/authoring.md`.

