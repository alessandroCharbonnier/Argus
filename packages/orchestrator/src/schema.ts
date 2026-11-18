const SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://argus.dev/e2e-plan.schema.json',
  title: 'Argus e2e-plan',
  type: 'object',
  required: ['env', 'reset', 'tests'],
  additionalProperties: true,
  properties: {
    project_root: {
      type: 'string',
      description:
        'Root for all relative paths and the Playwright spawn cwd. Defaults to the plan file directory.',
    },
    output_dir: {
      type: 'string',
      description:
        'Where runs, artifacts, and reports are written. Defaults to <project_root>/.argus.',
    },
    env: {
      type: 'object',
      required: ['base_url', 'workers', 'env_marker'],
      properties: {
        base_url: { type: 'string', pattern: '^https?://' },
        workers: { type: 'integer', minimum: 1 },
        version_endpoint: {
          type: 'string',
          description: "Polled for drift; the string 'off' disables the drift guard.",
        },
        env_marker: {
          type: 'object',
          required: ['url', 'expect_json'],
          properties: {
            url: { type: 'string' },
            expect_json: {
              type: 'object',
              description:
                'Field-by-field subset compared against the parsed marker JSON. The db field must be computed by the app from its live connection.',
            },
            headers: { type: 'object', additionalProperties: { type: 'string' } },
          },
        },
        vars: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Extra env vars passed to every node process.',
        },
        global_timeout_seconds: { type: 'integer' },
        drift_interval_seconds: { type: 'integer', default: 600 },
        storm_probe_seconds: { type: 'integer', default: 60 },
        storm_timeout_seconds: { type: 'integer', default: 600 },
      },
    },
    reset: {
      type: 'object',
      required: ['verify'],
      properties: {
        http: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', description: 'Must be same-origin as env.base_url.' },
            method: { type: 'string', default: 'POST' },
            headers: { type: 'object', additionalProperties: { type: 'string' } },
          },
        },
        command: { type: 'string' },
        attest: {
          type: 'object',
          required: ['command', 'expect_json'],
          properties: {
            command: { type: 'string', description: 'Read-only; runs BEFORE reset.command.' },
            expect_json: { type: 'object' },
          },
        },
        verify: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            expect_status: { type: 'integer' },
            expect_json: { type: 'object' },
          },
        },
      },
    },
    tests: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['test', 'crawl'], default: 'test' },
          spec: { type: 'string', description: 'Playwright spec path (kind: test).' },
          depends_on: { type: 'array', items: { type: 'string' } },
          critical: { type: 'boolean', default: false },
          idempotent: {
            type: 'boolean',
            default: false,
            description: 'Every uniqueness-constrained value derives from E2E_NAMESPACE.',
          },
          retries: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Requires idempotent: true.',
          },
          outputs: { type: 'array', items: { type: 'string' } },
          reads: { type: 'array', items: { type: 'string' } },
          writes: { type: 'array', items: { type: 'string' } },
          exclusive: {
            type: 'boolean',
            default: false,
            description: 'Drains the pool and runs alone.',
          },
          timeout_seconds: { type: 'integer', default: 900 },
          urls: {
            type: 'array',
            items: { type: 'string' },
            description: 'Crawler routes (kind: crawl).',
          },
          sitemap: { type: 'string' },
          login: {
            type: 'string',
            description: 'Login spec that saves a session into ARTIFACTS_DIR.',
          },
        },
      },
    },
  },
} as const;

export function printSchema(): string {
  return JSON.stringify(SCHEMA, null, 2) + '\n';
}
