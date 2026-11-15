import { readFile } from 'node:fs/promises';

export class ConfigError extends Error {
  readonly code = 'INVALID_CONFIG';
  constructor(message: string) { super(message); this.name = 'ConfigError'; }
}

export interface DoctorConfig {
  url: string;
  token?: string;
  timeoutMs: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseConfig(value: unknown, env: NodeJS.ProcessEnv = process.env): DoctorConfig {
  if (!object(value) || Object.keys(value).some(k => !['backend', 'timeoutMs'].includes(k))) {
    throw new ConfigError('Expected a config object containing backend and optional timeoutMs.');
  }
  const backend = value['backend'];
  if (!object(backend) || Object.keys(backend).some(k => !['url', 'tokenEnv'].includes(k))
      || typeof backend['url'] !== 'string' || !backend['url'].trim()) {
    throw new ConfigError('backend must contain url and optional tokenEnv; inline credentials are not supported.');
  }
  const timeoutMs = value['timeoutMs'] ?? 5000;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new ConfigError('timeoutMs must be an integer from 1 to 60000.');
  }
  const result: DoctorConfig = { url: backend['url'], timeoutMs };
  if (backend['tokenEnv'] !== undefined) {
    const key = backend['tokenEnv'];
    if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ConfigError('tokenEnv must name an environment variable.');
    }
    const token = env[key];
    if (!token) throw new ConfigError('The configured token environment variable is not set.');
    result.token = token;
  }
  return result;
}

export async function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<DoctorConfig> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch { throw new ConfigError('Cannot read the config file.'); }
  if (Buffer.byteLength(text) > 64 * 1024) throw new ConfigError('Config file exceeds 64 KiB.');
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new ConfigError('Config file must contain valid JSON.'); }
  return parseConfig(parsed, env);
}
