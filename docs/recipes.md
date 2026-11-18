# Reset recipes

Argus makes zero assumptions about your stack. The seam is two opaque hooks:
an **environment marker** (HTTP JSON) and a **reset** (HTTP or shell command).

## HTTP reset (preferred)

Same-origin as `base_url`, verified after it runs:

```yaml
reset:
  http: { url: /api/e2e/reset, method: POST }
  verify:
    url: /api/health
    expect_status: 200
    expect_json: { seeded: true }
```

## Command reset (e.g. ssh, docker exec, make)

A command reset runs a **read-only `attest` first** over the same transport,
and compares its parsed JSON field-by-field with the HTTP marker — before
anything destructive. The target-side script must also refuse unless its own
environment says staging.

```yaml
reset:
  command: ssh staging 'cd /app && make reseed'
  attest:
    command: ssh staging 'cd /app && make show-env'
    expect_json: { env: staging, db: staging-db }
  verify:
    url: /api/health
    expect_json: { seeded: true }
```

The command runs through the platform shell (`/bin/sh -c` on POSIX,
`cmd.exe /c` on Windows), so the plan file is the only per-platform variance.

## Containerized stacks

The tool is transport-agnostic: containers are invisible to it. Point
`base_url` at the exposed frontend and use `docker compose exec` for the reset
when there is no HTTP reset route:

```yaml
reset:
  command: docker compose exec -T app sh -c 'make reseed'
  attest:
    command: docker compose exec -T app sh -c 'make show-env'
    expect_json: { env: staging, db: staging-db }
  verify:
    url: /api/health
    expect_json: { seeded: true }
```

## The marker endpoint

```json
{ "env": "staging", "db": "staging-db", "seeded": true }
```

- `env` is the deployment identity.
- `db` **must be computed by the app from its live connection**, never read
  from a config label. An app pointed at the prod database is exactly the
  failure this catches.
- `expect_json` is a strict-typed subset: declared fields must equal (`1` ≠
  `"1"`); extra response fields are ignored.

## Secrets

Any string in the plan supports `${VAR}` interpolation, and every HTTP hook
takes optional `headers`:

```yaml
env:
  env_marker:
    url: /api/health
    headers: { Authorization: 'Bearer ${E2E_TOKEN}' }
    expect_json: { env: staging }
```

Keep secrets out of the committed plan file.
