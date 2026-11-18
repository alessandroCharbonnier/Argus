import { describe, expect, it } from 'vitest';
import { EXIT } from '../src/exitcodes.js';
import type { GateReport } from '../src/gate/gate.js';
import { decideOutcome } from '../src/run.js';
import type { NodeState, SchedulerSummary } from '../src/scheduler.js';

function summary(states: Record<string, NodeState>, aborted = false): SchedulerSummary {
  return {
    states: new Map(Object.entries(states)),
    attempts: new Map(),
    details: new Map(),
    aborted,
  };
}

const noGate: GateReport = {
  denominator: 1,
  numerator: 1,
  covered: ['a'],
  uncovered: [],
  denominatorKeys: ['a'],
  excluded: [],
};

describe('exit-code mapping', () => {
  it('maps a fully-passed run to exit 0', () => {
    const { exitCode } = decideOutcome(
      { exitCode: EXIT.invalid },
      summary({ a: 'passed' }),
      noGate,
      {},
    );
    expect(exitCode).toBe(EXIT.ok);
  });

  it('maps any failed node to exit 1', () => {
    const { exitCode } = decideOutcome(
      { exitCode: EXIT.invalid },
      summary({ a: 'failed', b: 'passed' }),
      noGate,
      {},
    );
    expect(exitCode).toBe(EXIT.red);
  });

  it('maps a critical abort to exit 1', () => {
    const { exitCode } = decideOutcome(
      { exitCode: EXIT.invalid },
      summary({ a: 'failed', b: 'aborted' }, true),
      noGate,
      {},
    );
    expect(exitCode).toBe(EXIT.red);
  });

  it('maps a fatal guard error to exit 3 (invalid)', () => {
    const { outcome, exitCode } = decideOutcome(
      { reason: 'env changed', exitCode: EXIT.invalid },
      summary({ a: 'passed' }),
      noGate,
      {},
    );
    expect(outcome).toBe('invalid');
    expect(exitCode).toBe(EXIT.invalid);
  });

  it('maps a held infra subtree to exit 4 (incomplete)', () => {
    const { outcome, exitCode } = decideOutcome(
      { exitCode: EXIT.invalid },
      summary({ a: 'blocked', b: 'held' }),
      noGate,
      {},
    );
    expect(outcome).toBe('incomplete');
    expect(exitCode).toBe(EXIT.incomplete);
  });

  it('maps uncovered controls to exit 4 (incomplete)', () => {
    const gate: GateReport = { ...noGate, uncovered: ['button:/:Delete'] };
    const { outcome, exitCode } = decideOutcome(
      { exitCode: EXIT.invalid },
      summary({ a: 'passed' }),
      gate,
      {},
    );
    expect(outcome).toBe('incomplete');
    expect(exitCode).toBe(EXIT.incomplete);
  });
});
