# Authoring specs and plans

This guide is written to be machine-friendly (for AI coding agents) and
human-friendly at once. Field semantics are exact; read them literally.

## The plan file — `e2e-plan.yaml`

```yaml
env:
  base_url: http://localhost:3000 # absolute http(s) URL
  workers: 2 # fixed pool size
  version_endpoint: /api/version # polled for drift; "off" disables
  env_marker:
    url: /api/health # parsed JSON, compared field-by-field
    expect_json: { env: staging } # strict-typed SUBSET match
  vars: { FLAG: '1' } # passed to every node process

reset:
  http: # same-origin as base_url
    url: /api/e2e/reset
    method: POST
  # command: 'curl -X POST http://localhost:5000/api/e2e/reset'
  # attest:                                  # read-only, runs BEFORE command
  #   command: 'curl http://localhost:5000/api/health'
  #   expect_json: { env: staging }
  verify:
    url: /api/health
    expect_status: 200
    expect_json: { seeded: true }

tests:
  - id: seed-accounts
    spec: specs/seed-accounts.spec.ts
    critical: true
    outputs: [account_id]
  - id: journey
    spec: specs/journey.spec.ts
    depends_on: [seed-accounts]
    reads: [account_id]
    writes: [account_id]
```

### Rules that are validated at parse time (with `file:line`)

- `env_marker` is mandatory; `reset` is mandatory; `reset.verify` is mandatory.
- `depends_on` edges must reference existing node ids; cycles are rejected.
- Every `reads` key must appear in some transitive ancestor's `outputs`.
- `retries: N` (N > 0) requires `idempotent: true`.
- `kind: test` requires `spec`; `kind: crawl` requires `urls` and/or `sitemap`.
- Missing spec files are rejected before anything runs.

### Semantics you must honor by hand

- **`idempotent: true` means every uniqueness-constrained value the node creates
  derives from `E2E_NAMESPACE`** (emails, slugs, names). The orchestrator cannot
  prove this — it is declared honestly.
- `writes` is a resource lock. Two ready nodes whose `writes` intersect never
  run concurrently. `exclusive: true` drains the pool and runs alone.
- A `critical` node failure after allowed retries aborts the whole run.
- Dependents of a failed node are cascade-skipped; dependents of an
  infrastructure-blocked node are **held**, not failed.

## Specs

```ts
import { expect, grab, publish, test } from '@e2e-orchestrator/playwright';

test('create and publish an account', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Name').fill('alice');
  await page.getByTestId('create-account').click();
  await expect(page).toHaveURL(/\/accounts\/\d+$/);
  const id = new URL(page.url()).pathname.split('/').pop();
  await publish({ account_id: id });
});
```

### Node contract (env vars)

Every node process receives `BASE_URL`, `ARTIFACTS_DIR`,
`E2E_NAMESPACE` (`e2e-<node-id>-a<attempt>`), and the plan's `env.vars`.

- `publish(outputs)` merges into `ARTIFACTS_DIR/publish.json`.
- `grab('ancestor-id')` reads a transitive ancestor's `publish.json`. A
  non-ancestor is an undeclared edge → runtime error, not silent staleness.

### The recorder wrapper

- Import `test` from `@e2e-orchestrator/playwright`, **never**
  `@playwright/test`, in spec files. A spec without a recorder heartbeat fails
  with "recorder silent".
- The recorder counts only `event.isTrusted` interactions; synthetic
  `dispatchEvent` never counts.
- The wrapper records `recorded.json`, `http.json`, `console.json`,
  `heartbeat.json` into `ARTIFACTS_DIR`.

## Crawler nodes

```yaml
- id: crawl-baseline
  kind: crawl
  depends_on: [seed-accounts]
  login: specs/login-as-admin.spec.ts # optional; runs first, saves a session
  urls: ['/']
  sitemap: /sitemap.xml # optional, unioned with urls
```

The login snippet is an ordinary Playwright spec that navigates and saves the
session:

```ts
test('save a session for the crawler', async ({ page }) => {
  await page.goto('/');
  await page.context().storageState({
    path: `${process.env.ARTIFACTS_DIR}/session.json`,
  });
});
```

## Element gate

- Denominator = crawler controls (both passes unioned) + recorder-seen controls.
- Numerator = controls exercised by **passed** tests.
- Identity key: `link:<href>` for `<a>`; `<tag>:<route>:<name|test-id|text>`
  otherwise. Repeated controls (500 "Delete" buttons) collapse to one.
- `exclusions.yaml` lists exact identity keys the gate may ignore.
- The gate measures **exercised**, not "works" — assertions prove "works".

## Fault-injection rides

The product is an **automated user journey where the user is actively trying to
break the app**. A node can declare a deterministic fault sweep — the same spec
re-runs once per fault, in fixed order, with the fault injected at a URL.

```yaml
- id: payment-journey
  spec: specs/payment.spec.ts
  faults:
    when: POST /api/payment # injection point: METHOD /path or /path
    sweep: [clean, timeout, 5xx, reset, latency] # fixed order; clean always first
    fail: true # default: ungraceful pass fails the run
    allow: [reset] # known-issue allowlist
    error_selector: '[data-testid="payment-error"]'
```

- `when` is a URL match (substring of pathname, with `*` glob). The first
  matching request in each pass gets the fault.
- Fault taxonomy: `clean` (no injection) · `timeout` (request hangs) · `5xx`
  (503) · `reset` (connection reset) · `latency` (stalled then completes).
- The node passes iff `clean` passes **and** every non-allowed fault pass is
  graceful. Ungraceful + `fail: true` → node `failed`, exit `1`.

### Writing a fault-aware spec

The wrapper exposes an `argusFault` fixture (`null` on the clean pass):

```ts
test('payment journey survives faults', async ({ page, argusFault }) => {
  await page.goto('/');
  // ... drive the journey up to the payment ...
  await page.getByTestId('pay').click();
  if (argusFault && ['timeout', '5xx', 'reset'].includes(argusFault.type)) {
    await expect(page.getByTestId('payment-error')).toBeVisible(); // graceful
  } else {
    await expect(page).toHaveURL(/\/confirmation/); // normal success
  }
});
```

### The four ways a fault pass can fail (and what to assert)

1. **crashed** — uncaught exception / `pageerror` (auto-detected).
2. **silent** — no crash, but no error element shown (`error_selector`).
3. **stranded** — error shown, but retry/back cannot recover.
4. **robbed** — journey "succeeded" but state corrupted (empty basket,
   duplicate charge) — assert with `state_check`.

A pass is graceful only if none of the four happened.

## Redaction

Traces, videos, and `publish()` artifacts can contain passwords. v1 ships a
documented redaction config: `mask` locators for password inputs and pattern
scrubbing of artifact JSON. Treat `.argus/` output as sensitive.
