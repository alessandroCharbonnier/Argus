export type HttpHeaders = Record<string, string>;

export interface EnvMarkerConfig {
  url: string;
  expect_json: Record<string, unknown>;
  headers?: HttpHeaders;
}

export interface EnvConfig {
  base_url: string;
  workers: number;
  version_endpoint?: string; // absent or 'off' disables the drift guard
  env_marker: EnvMarkerConfig;
  vars?: Record<string, string>;
  global_timeout_seconds?: number;
  drift_interval_seconds: number;
  storm_probe_seconds: number;
  storm_timeout_seconds: number;
}

export interface ResetHttp {
  url: string;
  method: string;
  headers?: HttpHeaders;
}

export interface ResetConfig {
  http?: ResetHttp;
  command?: string;
  attest?: { command: string; expect_json: Record<string, unknown> };
  verify: {
    url?: string;
    expect_status?: number;
    expect_json?: Record<string, unknown>;
  };
}

export type NodeKind = 'test' | 'crawl';

export interface TestNode {
  id: string;
  kind: NodeKind;
  spec?: string;
  depends_on: string[];
  critical: boolean;
  idempotent: boolean;
  retries: number;
  outputs: string[];
  reads: string[];
  writes: string[];
  exclusive: boolean;
  timeout_seconds: number;
  line: number;
  // crawler-only
  urls: string[];
  sitemap?: string;
  login?: string;
}

export interface Plan {
  file: string;
  project_root: string;
  output_dir: string;
  env: EnvConfig;
  reset: ResetConfig;
  tests: TestNode[];
}

export const DEFAULT_NODE_TIMEOUT_SECONDS = 15 * 60;
export const DEFAULT_DRIFT_INTERVAL_SECONDS = 10 * 60;
export const DEFAULT_STORM_PROBE_SECONDS = 60;
export const DEFAULT_STORM_TIMEOUT_SECONDS = 10 * 60;
