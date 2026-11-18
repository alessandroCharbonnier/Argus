# OSS element/UI-coverage landscape — evaluation

As of 2026-11-18. Goal: find existing tools that build a **denominator** of
discoverable UI controls and a **numerator** of exercised ones, before
production-izing the orchestrator's element gate.

## Candidates checked (live, 2026-11-18)

| Tool                              | License / activity          | Denominator                                                                       | Numerator                                                    | Verdict for the gate                                                                                  |
| --------------------------------- | --------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| storybookjs/addon-coverage        | MIT, active                 | none (Istanbul **code** coverage)                                                 | code paths                                                   | Not reusable. "UI coverage" in Storybook land = component code coverage.                              |
| qawolf                            | Apache-2.0, active platform | none                                                                              | flows (AI-generated)                                         | Old OSS recorder deprecated; no coverage concept. The recorder→test loop is what they commercialized. |
| recheck-web                       | AGPL-3.0, **dormant**       | **yes** — full-page Golden Master element snapshot + similarity re-identification | no                                                           | Steal denominator concept only. Selenium-only, AGPL.                                                  |
| Sakuli                            | EOL (v1)                    | none                                                                              | per-step assertions                                          | Not reusable. Only the "assert after every action" rigor idea.                                        |
| Playwright codegen                | Apache-2.0, active          | none                                                                              | recorded actions, **role → text → test-id locator priority** | Best default identity chain for the recorder numerator.                                               |
| Crawlee                           | Apache-2.0, very active     | inventories **URLs**, not controls                                                | no                                                           | Not the gate — but `PlaywrightCrawler` is a ready-made harness for the crawler denominator.           |
| anishkny/playwright-test-coverage | MIT, dormant                | none                                                                              | code coverage                                                | Confirmed code coverage; npm is polluted with same-name code-coverage tools.                          |
| Percy / Applitools                | commercial SaaS             | visual snapshots                                                                  | screenshot coverage                                          | Non-OSS baseline. Visual diff ≠ element-exercised gate.                                               |

## New finds

### 1. indigolain/playwright-ui-coverage (MIT, active, v0.2.0) — closest existing tool

- Prints exactly our shape: `UI coverage: 58.8% (60/102)`, per-page, with
  element overlays, per-element covering tests, CI thresholds and a baseline
  mode that fails **only on new untested elements**.
- **Identity: "attributes and position, never text"** — repeated controls
  (Delete on every row) count once; links keyed by destination page.
- **Report-time rules**: coverage computed at report time from a versioned,
  JSON-Schema'd `coverage.json` — can re-key without re-running tests.
- Gap: denominator is derived from DOMs reached during test runs — no
  standalone crawler pass (our plan's denominator).

### 2. munna7862/proofline (MIT, pre-release, solo) — our conceptual sibling

- In-browser agent inventories elements **and** records interactions;
  per-page reports; `npx proofline check --min-coverage N` CI gate.
- "Only passing tests count." Bonus: fault-injection scan (`proofline scan`)
  breaks each API call and flags tests that stay green while the app breaks.
- Gap: inventory runs inside the test runner, not an independent graph node.

### 3. Nikita-Filonov/ui-coverage-tool (Apache-2.0, active-ish)

- Manual `tracker.track_coverage(selector, ActionType, SelectorType)` per
  interaction; rich report with live-app overlays. No denominator.
- Stealable: **action-type taxonomy** (CLICK, FILL, VISIBLE…) grades
  interaction depth, not just binary touched.

## Answers

1. **Does any tool implement the full gate (independent crawler denominator +
   trusted-interaction numerator + enforced gate)? No.** The two near-misses
   have run-derived denominators. The crawler-denominator + recorder-numerator
   split is a genuine gap — we are not reinventing an existing wheel.
2. **Best identity scheme seen:** indigolain's structural signature
   (tag + stable attributes + position, text-free for stability, repeated-group
   dedup, destination-keyed links), with Playwright codegen's
   role → text → test-id chain as fallback.
3. **Three ideas to adopt:**
   - Versioned, schema'd raw event log; coverage/grouping/identity rules
     applied at report time; baseline mode failing only on newly uncovered
     controls; count only passing tests. → M7 artifacts, M8 gate, M9 reports.
   - Structural identity keys with position/group dedup + fallback chain.
     → M8 element gate (replaces spike's text-first key).
   - Proof axis later: proofline-style dependency fault injection + action
     depth grading, so numerator counts depth not just touch. → post-M11.

## Decision for the orchestrator

Keep the plan's crawler-denominator + recorder-numerator split (unclaimed
territory). Adopt report-time rules + a versioned event log. Spike identity
keys stay provisional; M8 will re-key with the structural scheme above.
