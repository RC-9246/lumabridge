/** Read-only OneBot diagnostics. This module never retries or selects another backend. */
export interface ProbeResult {
  backend: { name: string; version: string };
  health: { transport: boolean; online: boolean | null; good: boolean | null };
  account?: { id: string };
  observedAt: string;
}

export type ProbeErrorCode =
  | 'INVALID_URL'
  | 'INVALID_TOKEN'
  | 'INVALID_TIMEOUT'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'REDIRECT'
  | 'UNAUTHORIZED'
  | 'HTTP_ERROR'
  | 'RESPONSE_TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_RESPONSE'
  | 'ACTION_FAILED'
  | 'ASYNC_RESPONSE';

const ERROR_MESSAGES: Record<ProbeErrorCode, string> = {
  INVALID_URL: 'Expected an HTTP(S) endpoint without credentials, query, or fragment.',
  INVALID_TOKEN: 'The access token has an invalid format.',
  INVALID_TIMEOUT: 'The total timeout must be an integer from 1 to 60000 milliseconds.',
  NETWORK_ERROR: 'The diagnostic connection could not be completed.',
  TIMEOUT: 'The diagnostic deadline expired.',
  REDIRECT: 'The endpoint attempted to redirect the diagnostic request.',
  UNAUTHORIZED: 'The endpoint rejected diagnostic authentication.',
  HTTP_ERROR: 'The endpoint returned an unsuccessful HTTP response.',
  RESPONSE_TOO_LARGE: 'The diagnostic response exceeded the size limit.',
  INVALID_JSON: 'The endpoint did not return valid JSON.',
  INVALID_RESPONSE: 'The endpoint returned an invalid OneBot diagnostic response.',
  ACTION_FAILED: 'A read-only OneBot diagnostic action failed.',
  ASYNC_RESPONSE: 'The endpoint returned an unconfirmed asynchronous result.',
};

/** Error messages and properties deliberately exclude server text and request details. */
export class OneBotProbeError extends Error {
  readonly code: ProbeErrorCode;

  constructor(code: ProbeErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'OneBotProbeError';
    this.code = code;
  }
}

export interface ProbeOptions {
  url: string;
  token?: string;
  timeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const ACTIONS = ['get_version_info', 'get_status', 'get_login_info'] as const;
type DiagnosticAction = (typeof ACTIONS)[number];
type JsonObject = Record<string, unknown>;

function endpoint(value: string): URL {
  try {
    if (typeof value !== 'string' || value.trim() !== value || /[?#]/u.test(value)) {
      throw new Error();
    }
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error();
    }
    parsed.pathname = `${parsed.pathname.replace(/\/+$/u, '')}/`;
    return parsed;
  } catch {
    throw new OneBotProbeError('INVALID_URL');
  }
}

function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function name(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new OneBotProbeError('INVALID_RESPONSE');
  }
  return value.trim();
}

function state(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new OneBotProbeError('INVALID_RESPONSE');
  return value;
}

function accountId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === 0) return undefined;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new OneBotProbeError('INVALID_RESPONSE');
    }
    return String(value);
  }
  if (typeof value !== 'string' || !/^\d{1,64}$/u.test(value)) {
    throw new OneBotProbeError('INVALID_RESPONSE');
  }
  const normalized = value.replace(/^0+(?=\d)/u, '');
  return normalized === '0' ? undefined : normalized;
}

async function readJson(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/u.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new OneBotProbeError('RESPONSE_TOO_LARGE');
  }
  if (!response.body) throw new OneBotProbeError('INVALID_JSON');

  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new OneBotProbeError('RESPONSE_TOO_LARGE');
      }
      bytes.set(value, total - value.byteLength);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total))) as unknown;
  } catch {
    throw new OneBotProbeError('INVALID_JSON');
  }
}

function successfulData(value: unknown): JsonObject {
  if (
    !object(value) ||
    !['ok', 'failed', 'async'].includes(value.status as string) ||
    typeof value.retcode !== 'number' ||
    !Number.isSafeInteger(value.retcode)
  ) {
    throw new OneBotProbeError('INVALID_RESPONSE');
  }
  if (value.status === 'async') throw new OneBotProbeError('ASYNC_RESPONSE');
  if (value.status !== 'ok' || value.retcode !== 0) {
    throw new OneBotProbeError('ACTION_FAILED');
  }
  if (!object(value.data)) throw new OneBotProbeError('INVALID_RESPONSE');
  return value.data;
}

/**
 * Checks exactly three read-only actions under a single bounded deadline.
 * A successful HTTP exchange is not evidence of message delivery or write capabilities.
 */
export async function probeOneBot(options: ProbeOptions): Promise<ProbeResult> {
  const base = endpoint(options.url);
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new OneBotProbeError('INVALID_TIMEOUT');
  }
  if (
    options.token !== undefined &&
    (typeof options.token !== 'string' || !/^[\x21-\x7e]{1,8192}$/u.test(options.token))
  ) {
    throw new OneBotProbeError('INVALID_TOKEN');
  }

  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;

  const request = async (action: DiagnosticAction): Promise<JsonObject> => {
    let response: Response;
    try {
      response = await fetch(new URL(action, base), {
        method: 'POST',
        headers,
        body: '{}',
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      // With redirect:error, Fetch intentionally exposes no redirect response.
      // Do not inspect runtime exception text: it can contain URLs or secrets.
      throw new OneBotProbeError(timedOut ? 'TIMEOUT' : 'NETWORK_ERROR');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) {
        throw new OneBotProbeError('UNAUTHORIZED');
      }
      if (response.status >= 300 && response.status < 400) {
        throw new OneBotProbeError('REDIRECT');
      }
      throw new OneBotProbeError('HTTP_ERROR');
    }
    return successfulData(await readJson(response));
  };

  try {
    const version = await request(ACTIONS[0]);
    const backend = { name: name(version.app_name), version: name(version.app_version) };
    const status = await request(ACTIONS[1]);
    const health = { transport: true, online: state(status.online), good: state(status.good) };
    const login = await request(ACTIONS[2]);
    const id = accountId(login.user_id);
    if (timedOut) throw new OneBotProbeError('TIMEOUT');
    return {
      backend,
      health,
      ...(id === undefined ? {} : { account: { id } }),
      observedAt: new Date().toISOString(),
    };
  } catch (error: unknown) {
    if (timedOut) throw new OneBotProbeError('TIMEOUT');
    if (error instanceof OneBotProbeError) throw error;
    throw new OneBotProbeError('NETWORK_ERROR');
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
}
