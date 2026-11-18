export const EXIT = {
  ok: 0,
  red: 1,
  config: 2,
  invalid: 3,
  incomplete: 4,
  sigint: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
