import { readFileSync } from 'node:fs';
import type { Plan } from './types.js';
import { PlanError } from '../errors.js';
import { annotateYaml } from './annotate.js';
import { validatePlan } from './validate.js';

/** Load and validate `e2e-plan.yaml`. Throws `PlanError` with file:line issues. */
export function loadPlan(planPath: string, env: NodeJS.ProcessEnv = process.env): Plan {
  let text: string;
  try {
    text = readFileSync(planPath, 'utf8');
  } catch {
    throw new PlanError([{ message: `cannot read plan file: ${planPath}` }]);
  }
  const annotated = annotateYaml(text);
  const { plan, issues } = validatePlan(annotated, planPath, env);
  if (issues.length > 0) throw new PlanError(issues);
  return plan;
}
