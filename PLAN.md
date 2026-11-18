# E2E Orchestrator — Plan v4

**Goal:** a public tool that runs hand-written **Playwright** tests against a **real running backend on a dev/staging environment — never production** (nothing mocked), on a dependency graph, for hours if needed. The app under test may use any stack; browser automation is Playwright. The gate proves every **discoverable** control was **exercised**; whether it *works* is proven by each test's assertions.

**Hard rules (not configurable away):**
1. Production is off-limits. Target is always a dev/staging environment with a dev database.
2. Before any reset or test runs, the target must return a **positive environment marker** over HTTP attesting **both the app and the database identity**. The marker is parsed JSON compared **field by field** — never substring matching. The `db` field must be **computed by the app from its live connection**, not read from a config label. No marker = hard abort.
3. Reset channels: HTTP reset on the same origin as `base_url` is preferred. A command reset must be preceded by a **read-only `attest` command over the same transport**, whose parsed JSON output is compared field-by-field with the HTTP marker. The attestation is checked **before** the reset runs — not after the damage is done. The target-side script must also independently refuse unless its own environment says staging. The marker is re-checked before reset, before the run, and **on every drift poll**.

**User:** any full-stack developer who is morally obligated to ship working software.

**Design philosophy:** the orchestrator is a **thin scheduler over Playwright**, not a full test engine. Playwright owns execution, reporters, traces, videos, and blob reports. The orchestrator builds only what Playwright cannot do: the dependency graph, resource contracts, environment guard, critical/exclusive scheduling, and the element-exercised gate. (Note: native Playwright already skips dependents when a dependency project fails — the scheduler exists for per-node `critical`, resource locks, and env checks between stages, not for skip propagation.)

---

## 1. Core decisions

| Piece | Decision |
|---|---|
| Engine | Thin **Node/TypeScript** scheduler; **Playwright** executes each node by path (`playwright test specs/x.spec.ts --project=chromium`) |
| Tests | Hand-written Playwright specs, one per graph node. **No generated per-node projects** (unmaintainable at 140 nodes) |
| Graph | `e2e-plan.yaml`, explicit `depends_on` edges + `reads`/`writes` resource declarations. No `parallel` key |
| Scheduling | Fixed `workers: N`; two ready nodes with **conflicting `writes` never run concurrently**; `exclusive` = writes-all special case |
| Data passing | Artifacts per attempt (`artifacts/<node>/a<n>.json`) + `publish()` / `grab()`; `grab()` is ancestors-only, transitive, runtime-checked |
| Environment | Any **dev/staging** env (never prod); config hooks only, zero assumptions about user stack |
| Prod guard | JSON-field marker (app + live DB identity), read-only `attest` pre-reset over same transport, re-checked on every drift poll |
| DB reset | `reset: {http or command, verify}` — verify mandatory, fail = abort |
| Drift guard | Version endpoint polled; change mid-run = abort `invalid: env changed`; marker re-checked at each poll |
| Failures | Retry default **0 everywhere**; opt-in `idempotent: true` + `retries`. Independents continue; dependents skip; `critical` aborts run |
| Outage handling | `blocked: infra` state for mid-flight nodes overlapping a freeze window; re-queue if idempotent, else run ends `incomplete: infra` with subtree held |
| Stability | Failure-storm circuit breaker: freeze → probe health → resume if healthy, else abort `invalid: env unhealthy` |
| Timeouts | Per-node 15 min default (kill → `failed: timeout`), optional global cap |
| Element gate | Union denominator (crawler ×2 + recorder), crawler as graph node, shared identity-key function, recorder heartbeat |
| Browser | Chromium only in v1 (matrix = v2) |
| Reporting | Terminal + HTML + `report.json` + screenshot/video/trace per failure; blob reports merged, unique file per node+attempt |
| Resume / replay | Resume in v2. `--node X --from-run <id>` artifact replay in v1 (cheap debugging) |
| Distribution | Public repo, one install, docs recipes per backend stack |

## 2. The plan file — `e2e-plan.yaml`

```yaml
env:
  base_url: https://staging.example.com
  workers: 4                            # fixed in v1
  version_endpoint: /api/version        # optional; "off" disables drift guard
  env_marker:                           # mandatory, parsed JSON compared field-by-field
    url: /api/health
    expect_json: { env: "staging", db: "staging-db" }   # db computed from LIVE connection

reset:
  # HTTP reset on the SAME origin as base_url is preferred.
  http:
    url: https://staging.example.com/api/e2e/reset
    method: POST
  # For command reset: attest runs FIRST, read-only, over the same transport.
  # command: ssh staging 'cd /app && make reseed'
  # attest:
  #   command: ssh staging 'cd /app && make show-env'    # prints {"env":"staging","db":"staging-db"}
  #   expect_json: { env: "staging", db: "staging-db" }  # field-by-field vs HTTP marker
  verify:
    url: /api/health
    expect_status: 200
    expect_json: { seeded: true }

tests:
  - id: create-accounts
    spec: specs/create-accounts.spec.ts
    critical: true
    idempotent: true                    # every uniqueness-constrained value derives from E2E_NAMESPACE
    retries: 1
    outputs: [admin_user, user_1, user_2]
    writes: [admin_user, user_1, user_2]

  - id: crawl-baseline                    # crawler IS a graph node: needs accounts for role logins
    kind: crawl
    depends_on: [create-accounts]
    reads: [admin_user, user_1, user_2]

  - id: user-suite
    spec: specs/user-suite.spec.ts
    depends_on: [create-accounts]
    reads: [user_1]
    writes: [user_1]

  - id: pay-method
    spec: specs/pay-method.spec.ts
    depends_on: [user-suite]
    reads: [user_1]
    writes: [user_1]                     # conflicting writes never concurrent

  - id: add-to-cart
    spec: specs/add-to-cart.spec.ts
    depends_on: [pay-method]
    reads: [user_1]
    writes: [user_1]

  - id: order
    spec: specs/order.spec.ts
    depends_on: [add-to-cart]
    reads: [user_1]
    writes: [user_1]

  - id: crawl-final                        # second pass over a data-rich world
    kind: crawl
    depends_on: [order, global-settings-rebuild]
    reads: [admin_user, user_1]

  - id: global-settings-rebuild
    spec: specs/global-settings.spec.ts
    depends_on: [order]
    exclusive: true                     # = writes-all: blocks launches, drains, runs alone
```

Rules:
- `depends_on` = hard edge. `st(a,b,c)` chains compile to edges. Diamond dependencies allowed.
- `reads`/`writes`: scheduler never runs two ready nodes whose `writes` intersect. `exclusive` = `writes: [*]`. Declared `reads` must exist in some ancestor's `outputs` (validated at parse time).
- No `parallel` key. Nodes run whenever ready, a worker is free, and no write conflict.
- `critical: true` node failure after allowed retries aborts the whole run.
- `retries` default **0 everywhere**. Allowed only with `idempotent: true` + explicit `retries`.
- `idempotent: true` means precisely: **every uniqueness-constrained value the node creates derives from `E2E_NAMESPACE`** (emails, slugs, names). Declared honestly — the orchestrator cannot prove it.

## 3. Data passing — artifacts + namespace

- Every node gets `ARTIFACTS_DIR` and `E2E_NAMESPACE` env vars.
- Node publishes outputs per attempt: `publish({ admin_user: {...} })` → `artifacts/<node>/a<n>.json` (never overwritten).
- Node reads data only via `grab('create-accounts').admin_user` — **ancestors only, transitive** (a grandparent's artifact is readable). A `grab()` from a non-ancestor is an undeclared edge = race → runtime error, not silent staleness.
- Orchestrator verifies declared `outputs` exist and are non-empty **before** launching a dependent. Missing = clear error, no null-email mysteries.
- **Namespace semantics:**
  - Each node creates its own data under its own namespace: `e2e-<node-id>-a<attempt>`. The attempt number is part of the namespace — retries are structurally collision-free.
  - A node **reads** an ancestor's namespace from that ancestor's artifact; it never writes into it.
  - Journeys are the exception and are modeled explicitly: chain nodes declare `writes: [user_1]` and the scheduler serializes them against any other writer of `user_1`. No implicit sharing, no implicit isolation — everything declared.
- No hardcoded credentials.

## 4. Execution lifecycle

```
parse plan → validate resources (reads ⊆ ancestors' outputs, cycles, missing specs)
          → env marker check (parsed JSON, app + DB) — mandatory
          → preflight probe (base_url up, version recorded)
          → reset: HTTP same-origin, OR command preceded by read-only `attest`
                   (parsed JSON compared field-by-field with marker)
          → reset verify (fail = abort)
          → schedule ready nodes (topological, fixed pool, no conflicting writes)
          → run node (spawn `playwright test specs/x.spec.ts --project=chromium --workers=1`)
          → on node end: parse status, write per-attempt artifacts, recorder heartbeat check
          → retry only if idempotent && retries left (fresh attempt namespace)
          → cascades: skip dependents of failed nodes
          → infra failure storm → freeze → probe → resume;
            mid-flight nodes overlapping the storm → `blocked: infra`
          → end: merge blob reports → element gate (crawler ∪ recorder) → report
```

- Env marker mismatch, preflight fail, reset verify fail, or critical node fail → abort, report says why.
- Version change mid-run → abort `invalid: env changed`, no test blamed; marker re-checked at every poll.

## 5. Environment guard (the genuinely new part)

- **Marker = app + live DB identity, parsed JSON.** `"env":"staging"` on an app pointed at the prod database is the nightmare. The app computes `db` from its actual connection — a config label proves nothing. Compared field-by-field, never substring.
- **Reset binding.** HTTP reset on same origin as `base_url`. Command reset: read-only `attest` over the same transport runs **first**, output parsed and compared with the HTTP marker — before anything destructive. The target-side script independently refuses unless its own env says staging. Defense in two places, checked in the right order.
- **Drift:** poll `version_endpoint` (default 10 min) **and re-check the env marker at each poll**. Change mid-run → abort, run marked `invalid: env changed`.
- **Failure storm — exact semantics:** freeze only on infrastructure signals (5xx, connection refused, DNS failure, request timeout), **never** on assertion failures (a real regression must not freeze the run). On freeze: probe health every T (default 60 s); resume if healthy within timeout (default 10 min); else abort `invalid: env unhealthy`.
- **Mid-flight nodes during a storm:** if a node fails and its network log shows 5xx/connection errors overlapping the freeze window, it is `blocked: infra`, not `failed`. Its subtree is **held** (not skipped-as-failed). On health recovery: re-queue the node if idempotent; otherwise the run ends `incomplete: infra` with the subtree listed as held.

## 6. Failure semantics (exact)

- Retry default **0 everywhere**. Opt-in: `idempotent: true` + `retries: N`. Each attempt gets a fresh attempt-scoped namespace.
- Independent nodes keep running; dependents of a failed node become `skipped` (reason recorded).
- Terminal states: `passed / flaky (passed after retry) / failed / blocked: infra / skipped / aborted`.
- 15 min per-node timeout, kill → `failed: timeout`.
- Playwright's own retry is disabled — the orchestrator owns retry, one layer only.

## 7. Element-exercised gate (riskiest piece — spike first)

- **Denominator = crawler ∪ recorder, so it can never undercount.**
  - Crawler is a **graph node** (`kind: crawl`): it logs in per role using accounts from `create-accounts` (artifacts), takes a sitemap/URL list, resolves dynamic routes with artifact IDs, visits every page, records clickable controls, collapses repeated rows (500 "Delete" buttons = 1 control), and flags links whose destination is never visited.
  - **Crawl twice:** once after the reset (baseline) and once at end of run — a freshly reset DB has no rows, so per-row controls only exist later.
  - Recorder-seen controls are unioned in, so controls behind modals/menus that only a test opened still count.
- **Numerator is recorder-built.** Three routes to spike, in this order of promise:
  1. **Capturing DOM listener** via `context.addInitScript` + `context.exposeBinding`: a document-level listener records every real interaction, works in all three engines, no Locator proxying. Count only `event.isTrusted` events — synthetic `dispatchEvent` doesn't count. Needs the wrapper's auto-fixture to install it.
  2. Fixture wrapper (import `test` from `@e2e-orchestrator/playwright`).
  3. Trace-JSONL parsing (no spec changes, but versioned format, no stability guarantee).
  - Also spend one hour evaluating existing OSS element-coverage projects for reuse.
- **Identity-key function shared** by crawler and recorder — otherwise numerator and denominator never match. One function, both sides.
- **Heartbeat:** every node must produce at least one recorder heartbeat; a node without one fails with "recorder silent — check the import" (spec imported `@playwright/test` instead of the wrapper). Plus a lint rule banning the plain import.
- The **gate measures exercised, not "works"**. Whether it works is the job of the assertion after each interaction. **Enforcement via custom reporter, no wrapper needed:** steps carry categories (`expect`, `pw:api`), and the reporter receives step start/end events — rule: every interaction step must be followed by an expect step. Confirm `pw:api` step titles include locator identity in the spike.
- User maintains only an **exclusion list** (`exclusions.yaml`: decorative, hidden, intentionally untested controls).
- End gate: discovered control, not exercised by any passed test, not excluded → run `incomplete`.

## 8. Playwright operational contract (per spawned node process)

- Run by path: `playwright test specs/x.spec.ts --project=chromium` — no per-node generated projects. Per-spec overrides via `test.use()` inside the file. Browser matrix = v2.
- `--workers=1` — otherwise fixed N orchestrator workers × M Playwright workers = N×M browsers.
- `trace: 'retain-on-failure'`, `video: 'retain-on-failure'`, `screenshot: 'only-on-failure'`. **Never `trace: 'on-first-retry'`** — with retries disabled it records nothing.
- Blob output file: set `PLAYWRIGHT_BLOB_OUTPUT_FILE` to a unique name per node + attempt, else concurrent node processes overwrite each other's reports.
- Playwright retries: off (orchestrator owns retry).
- Journey specs use serial mode (`test.describe.configure({ mode: 'serial' })`) so a later step never runs on broken state and adds noise failures.

## 9. Reporting

- Terminal live line: `[12/140] running 4 | passed 55 | flaky 1 | failed 3 | blocked 2 | skipped 2`.
- Playwright blob reports merged at end → `report.json` (machine-readable) + HTML report.
- Per failed node: screenshot, video, trace, console log, last HTTP calls. No rerun needed for triage.
- Gate section: exercised controls, uncovered-but-not-excluded list, crawler denominator stats (per role, per crawl pass).
- Debugging: `--node order --from-run <id>` replays one node against a previous run's artifacts (ancestors not re-run — the native project-dependency quirk never applies because the orchestrator owns edges).
- **Credential redaction:** traces, videos, and artifacts can contain passwords typed during tests. v1 ships a documented redaction config (`mask` locators for inputs + patterns scrubbed from artifact JSON) and a warning in the README.

## 10. Non-goals (v1)

- **No production, ever.**
- No autoscaling ramp (fixed workers; circuit breaker only). Ramp = v2.
- No resume/checkpoint (full rerun on crash). v2, once idempotency contracts exist. (`--from-run` replay is v1.)
- No browser matrix (Chromium only). v2.
- No line-coverage gates (neither frontend V8 — Chromium-only, needs special unminified build — nor backend per-stack hooks). Optional plugins later, default off.
- No live web dashboard (terminal is enough).
- No AI anywhere — tests are hand-written; crawler and recorder are deterministic, not AI.
- No mocking of any backend service.

## 11. v2 path (explicitly deferred, not forgotten)

- Resume/checkpoint — safe because v1 establishes idempotency flags and attempt namespaces.
- Autoscale ramp-up/down on top of the fixed pool + circuit breaker.
- Browser matrix (webkit, firefox) on top of the chromium-only v1 runner.
- Line-coverage plugins (frontend via V8 CDP, backend via endpoint/command hook) with documented build requirements.

## 12. Build milestones (risk-first order)

1. **Spike the element gate** — three recorder routes (initScript+binding first, wrapper, trace parsing), crawler denominator (two passes, per-role, dedupe), shared identity-key function, reporter-based assertion rule. On a throwaway demo app. If the denominator can't be trustworthy, the pitch weakens — know this first. One hour evaluating existing OSS element-coverage projects.
2. Scaffold public-repo skeleton (npm, TS, lint, README).
3. Plan parser + validation (cycle detection, unknown deps, missing specs, diamond deps, `reads ⊆ ancestors' outputs`, write-conflict detection, retry/idempotency rules).
4. Env guard: JSON-field marker (app + live DB), read-only `attest` pre-reset, reset + verify, version drift poll with marker re-check, storm freeze/probe/resume + `blocked: infra` re-queue.
5. Scheduler: DAG topo-sort, fixed worker pool, resource-lock scheduling (`writes` intersection), `exclusive` = writes-all, critical abort.
6. Node runner: spawn `playwright test <spec> --project=chromium` with the operational contract from §8, timeout, opt-in retry with attempt namespaces, cascade skip, heartbeat check.
7. Artifacts: `publish`/`grab` helpers (ancestors-only, transitive, runtime-checked) + output verification + `--node X --from-run <id>` replay.
8. Element gate production form: crawler graph node, recorder helper package, exclusions list, gate report.
9. Reporting: blob report merge (unique files), terminal progress, HTML, `report.json`, failure artifacts, redaction config.
10. Example: tiny demo app + example plan + specs showing `publish`/`grab` + two crawler passes.
11. Docs: README guidance ("independent tests are best; the graph is for long journey tests where setup is expensive; declare reads/writes"), recipes for common stacks, the security story for the env guard.

---

## 13. Locked decisions (grilling session, 2026-11-18)

These supersede any conflicting text above. Resolved forks:

- **Authority:** this v4 plan governs over the original brief wherever they
  disagreed. No autoscaling ramp (fixed `workers: N`), no default retry
  (opt-in `idempotent + retries`), no line-coverage gates in v1.
- **AI tooling:** zero AI inside the tool (deterministic crawler/recorder).
  Ship machine-readable affordances for external agents: JSON Schema for
  `e2e-plan.yaml` (`--print-schema`) + `docs/authoring.md`.
- **Layout:** npm workspaces monorepo — `packages/orchestrator`
  (`@e2e-orchestrator/cli`, bin `e2e-orchestrator`), `packages/playwright`
  (`@e2e-orchestrator/playwright` wrapper), `examples/demo-app` (unpublished).
- **Node:** engines `>=22`, develop + CI on 24 (20 is EOL). TS 5 strict, ESM,
  ESLint 9 flat + typescript-eslint, Prettier, Vitest, commitlint + husky,
  Conventional Commits, Apache-2.0. Manual releases until v1 ships (no changesets).
- **Platform:** command hooks run through the platform shell (`/bin/sh -c` /
  `cmd.exe /c`); per-node timeout kills the whole process tree; CI on
  windows-latest + ubuntu-latest × Node 22/24; demo e2e native on both OSes +
  compose variant on ubuntu.
- **Demo:** Express + better-sqlite3, live-connection `db` marker, HTTP reset
  `/api/e2e/reset`, two pages + one button flow, two specs using
  `publish`/`grab`, two crawl passes, native + docker-compose variants.
- **Exit codes:** `0` green (passed/flaky), `1` red (failed/aborted), `2` config
  (plan/schema/flags), `3` invalid (marker/drift/env-unhealthy/prod-guard),
  `4` incomplete (gate miss, held infra subtree), `130` SIGINT.
- **Plan contract:** `project_root` key (default = plan file's dir); all
  relative paths resolve against it; spawn cwd = `project_root`.
- **Reset:** `reset` mandatory (every plan defines one), `verify` mandatory,
  fail = abort. Marker always mandatory.
- **`expect_json`:** strict-typed **subset** match, recursive (declared fields
  must equal; extra response fields ignored).
- **Secrets:** `${VAR}` env interpolation for any string value in the plan;
  `headers` allowed on all HTTP hooks.
- **Drift:** raw-body string compare (trimmed).
- **Env contract for nodes:** `BASE_URL`, `ARTIFACTS_DIR`, `E2E_NAMESPACE`,
  `PLAYWRIGHT_BLOB_OUTPUT_FILE`, plus `env.vars` pass-through.
- **Replay:** `--node X --from-run <id>` runs marker + preflight but skips
  reset + drift polling; `--unsafe-skip-guard` exists, loud, marks the run
  `invalid: unguarded`.
- **HTTP recording:** wrapper fixture records `http.json` (last N calls +
  timestamps) — feeds storm classification *and* the failure triage artifact.
- **Crawler surface:** `kind: crawl` nodes declare `urls` (+ optional `sitemap`),
  a hand-written `login` spec (runs first, saves storage state via the
  wrapper), and the identity key `route.path + tag + accessible-name|text`.
- **Storm classification source:** a failed node is `blocked: infra` iff its
  `http.json` shows 5xx/connection errors overlapping the freeze window.

## 14. Test scope (locked)

- **Unit (Vitest):** plan parser (cycles, unknown deps, missing specs,
  `reads ⊆ ancestors' outputs`, write-conflict detection, retry/idempotency,
  schema errors with `file:line`), scheduler (cascade-skip, critical abort,
  exclusive drain, `blocked: infra` re-queue, freeze/probe/resume, per-node
  timeout kill), env guard (marker subset compare, drift detection, storm
  classification), exit-code mapping, runner spawn/kill via a fake `playwright`
  shim.
- **Behaviour:** the bundled demo run (fresh run passes; critical failure →
  exit 1; gate miss → exit 4). The demo *is* the fake backend.


