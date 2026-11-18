import { EXIT } from './exitcodes.js';

export class ArgusError extends Error {
  override name = 'ArgusError';
  constructor(
    message: string,
    readonly exitCode: number = EXIT.config,
  ) {
    super(message);
  }
}

export interface PlanIssue {
  message: string;
  line?: number;
}

export class PlanError extends ArgusError {
  constructor(readonly issues: PlanIssue[]) {
    super(PlanError.format(issues));
  }

  private static format(issues: PlanIssue[]): string {
    return issues.map((i) => (i.line ? `line ${i.line}: ${i.message}` : i.message)).join('\n');
  }
}

export class GuardError extends ArgusError {
  constructor(message: string, exitCode: number = EXIT.invalid) {
    super(message, exitCode);
  }
}

export class StormAbort extends ArgusError {
  constructor(message: string) {
    super(message, EXIT.invalid);
  }
}
