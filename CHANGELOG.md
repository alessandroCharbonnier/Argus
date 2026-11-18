# Changelog

All notable changes to Argus are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/), versioning follows
[SemVer](https://semver.org/).

## [Unreleased]

### Added

- Monorepo layout: `packages/orchestrator` (`@e2e-orchestrator/cli`, bin
  `e2e-orchestrator`) and `packages/playwright`
  (`@e2e-orchestrator/playwright` recorder wrapper), plus `examples/demo-app`.
- Plan parser and validator: cycle detection, unknown dependencies, missing
  specs, `reads ⊆ ancestors' outputs`, retry/idempotency rules, schema errors
  with `file:line`, `${VAR}` interpolation.
- Environment guard: JSON field-by-field marker (app + live DB identity),
  read-only `attest` before command reset, reset verify, version drift poll
  with marker re-check, failure-storm circuit breaker with `blocked: infra`.
- Dependency-graph scheduler: fixed worker pool, `writes` conflict
  serialization, `exclusive` pool drain, critical abort, cascade skip, opt-in
  retry with attempt namespaces, blocked-infra hold-and-requeue.
- Node runner: spawns `node <playwright-cli> test <spec> --project=chromium
--workers=1`, per-node timeout with process-tree kill, JSON reporter parsing,
  recorder heartbeat check, failure-artifact capture (temp output dir).
- Artifacts: `publish()`/`grab()` helpers (transitive ancestors, runtime
  checked), file-based ancestor map, output verification, `--node --from-run`
  replay.
- Element gate: crawler graph node (login snippet, urls/sitemap, two passes),
  trusted-interaction recorder, shared identity-key function, `exclusions.yaml`.
- Reporting: live terminal line, `report.json`, self-contained HTML report,
  per-failed-node artifacts (screenshot/video/trace/console/http).
- Example: Express + SQLite demo app, `e2e-plan.yaml`, two specs with
  `publish`/`grab`, two crawler passes, Dockerfile + compose.
- Docs: `docs/authoring.md`, `docs/recipes.md`, JSON Schema (`--print-schema`).
- Tooling: Vitest, ESLint 9 flat config, Prettier, commitlint + husky,
  Apache-2.0, CI (unit matrix + demo e2e native/compose).

### Changed

- Switched the demo DB to `node:sqlite` (no native-module build risk).
- Deferred blob-report merging: the blob reporter conflicts with
  `trace: retain-on-failure` on Windows (EPERM on NAS); v1 ships a
  self-contained HTML report instead and relies on Playwright's own
  `test-results/` artifacts for triage.

## [0.1.0] - 2026-11-18

Initial scaffold. No orchestrator features yet (milestones 3+).
