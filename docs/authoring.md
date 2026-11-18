# Authoring specs and plans

This guide is written to be machine-friendly (for AI coding agents) and
human-friendly at once. Field semantics are exact; read them literally.

## The plan file — `e2e-plan.yaml`

```yaml
env:
  base_url: http://localhost:3000            # absolute http(s) URL
  workers: 2                                 # fixed pool size
  version_endpoint: /api/version             # polled for drift; "off" disables
  env_marker:
    url: /api/health                         # parsed JSON, compared field-by-field
    expect_json: { env: staging }            # strict-typed SUBSET match
  vars: { FLAG: "1" }                        # passed to every node process

reset:
  http:                                      # same-origin as base_url
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
  login: specs/login-as-admin.spec.ts   # optional; runs first, saves a session
  urls: ['/']
  sitemap: /sitemap.xml                 # optional, unioned with urls
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

## Redaction

Traces, videos, and `publish()` artifacts can contain passwords. v1 ships a
documented redaction config: `mask` locators for password inputs and pattern
scrubbing of artifact JSON. Treat `.argus/` output as sensitive.
