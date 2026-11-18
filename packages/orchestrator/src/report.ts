import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunPaths } from './artifacts.js';
import { writeJson } from './artifacts.js';
import type { GateReport } from './gate/gate.js';

export interface NodeReport {
  id: string;
  state: string;
  attempts: number;
  durationMs?: number;
  detail?: string;
  flaky?: boolean;
}

export interface RunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  planFile: string;
  baseUrl: string;
  outcome: string;
  exitCode: number;
  nodes: NodeReport[];
  gate?: GateReport;
  errors: string[];
}

export function writeReportJson(paths: RunPaths, report: RunReport): void {
  writeJson(paths.reportJsonPath, report);
}

export function formatLiveLine(total: number, states: Map<string, number>, done: number): string {
  const g = (k: string) => states.get(k) ?? 0;
  return (
    `[${done}/${total}] running ${g('running')} | passed ${g('passed')} | flaky ${g('flaky')} | ` +
    `failed ${g('failed')} | blocked ${g('blocked')} | skipped ${g('skipped')}`
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Self-contained HTML report. Blob-report merging is deferred (v1): the blob
 * reporter conflicts with `trace: retain-on-failure` on Windows, so v1 relies
 * on Playwright's own `test-results/` failure artifacts plus this summary.
 */
export function writeHtmlReport(paths: RunPaths, report: RunReport): void {
  const rows = report.nodes
    .map((n) => {
      const cls = n.state === 'passed' ? 'ok' : n.state === 'skipped' ? 'skip' : 'bad';
      return `<tr class="${cls}"><td>${escapeHtml(n.id)}</td><td>${escapeHtml(n.state)}</td><td>${
        n.attempts
      }</td><td>${n.durationMs ?? ''}</td><td>${escapeHtml(n.detail ?? '')}</td></tr>`;
    })
    .join('');

  const gate = report.gate
    ? `<h2>Element gate</h2>
       <p>exercised ${report.gate.numerator}/${report.gate.denominator} controls</p>
       ${
         report.gate.uncovered.length > 0
           ? `<ul>${report.gate.uncovered.map((u) => `<li>${escapeHtml(u)}</li>`).join('')}</ul>`
           : '<p>all discoverable controls exercised.</p>'
       }`
    : '';

  const errors =
    report.errors.length > 0
      ? `<h2>Errors</h2><ul>${report.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`
      : '';

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Argus run ${escapeHtml(
    report.runId,
  )}</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;color:#1a1a1a}
table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ddd;padding:.4rem .6rem;text-align:left}
th{background:#f5f5f5}
tr.ok td:first-child{color:#0a7d0a}
tr.bad{color:#b00020}
tr.skip{color:#888}
</style></head><body>
<h1>Argus run — ${escapeHtml(report.outcome)}</h1>
<p><code>${escapeHtml(report.runId)}</code> · plan <code>${escapeHtml(
    report.planFile,
  )}</code> · base <code>${escapeHtml(report.baseUrl)}</code></p>
<h2>Nodes</h2>
<table><thead><tr><th>node</th><th>state</th><th>attempts</th><th>ms</th><th>detail</th></tr></thead>
<tbody>${rows}</tbody></table>
${gate}
${errors}
</body></html>`;
  writeFileSync(path.join(paths.htmlReportDir, 'index.html'), html, 'utf8');
}
