import { ToolError } from '../types.js';
import { invalidateResourceApiKey, resourceApiKey, type ApiKeySource } from '../../identity/apiKey.js';

/**
 * Duffel API client.
 *
 * This is the only tool in the project that needs outbound authentication, which is
 * why it exists: the diagram's `outbound (API key / OAuth 2)` edge through AgentCore
 * Identity had nothing to enforce while every tool was keyless.
 *
 * Duffel uses a static bearer token rather than an OAuth 2 exchange, so there is no
 * token lifecycle to manage — the secret goes straight into the Authorization header.
 *
 * Where that secret comes from is the seam below, and it is the same seam idea as
 * `MemoryStore` and `ToolProvider`: one interface, an environment variable locally and
 * the AgentCore Identity token vault in the Runtime. `npm run dev` therefore exercises
 * the same code path minus the vault, rather than a different code path.
 */

const BASE_URL = process.env.DUFFEL_BASE_URL ?? 'https://api.duffel.com';
const API_VERSION = 'v2';
const TIMEOUT_MS = 15_000;

/** Which of the two credential sources is configured. Order matters — see `credential()`. */
export function hasCredentials(): boolean {
  return Boolean(process.env.DUFFEL_ACCESS_TOKEN ?? process.env.DUFFEL_CREDENTIAL_PROVIDER);
}

/**
 * The access token, and where it came from.
 *
 * The environment variable is checked first so a local run never needs AWS; the deployed
 * container has no `DUFFEL_ACCESS_TOKEN`, only `DUFFEL_CREDENTIAL_PROVIDER`, so in the
 * cloud the Identity path is the only one available. The source is returned rather than
 * hidden because it is the evidence: a `tool.credential` span saying `identity` is how we
 * know the vault was really used and not quietly bypassed by a leftover variable.
 */
async function credential(): Promise<{ token: string; source: ApiKeySource; provider?: string }> {
  const fromEnv = process.env.DUFFEL_ACCESS_TOKEN;
  if (fromEnv) return { token: fromEnv, source: 'env' };

  const provider = process.env.DUFFEL_CREDENTIAL_PROVIDER;
  if (provider) {
    const { key, source } = await resourceApiKey(provider);
    return { token: key, source, provider };
  }

  throw new ToolError(
    'Flight search is not configured: set DUFFEL_ACCESS_TOKEN locally, or ' +
    'DUFFEL_CREDENTIAL_PROVIDER so the key can be read from the AgentCore Identity token vault.',
  );
}

async function authHeaders(): Promise<{ headers: Record<string, string>; provider?: string }> {
  const { token, source, provider } = await credential();
  // Names only. The key is never logged, and there is a test asserting that.
  console.error(JSON.stringify({ type: 'diagnostic', event: 'duffel.credential', source, provider }));
  return {
    headers: {
      authorization: `Bearer ${token}`,
      'Duffel-Version': API_VERSION,
      accept: 'application/json',
    },
    provider,
  };
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const { headers, provider } = await authHeaders();
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { ...headers, ...init.headers },
    });

    if (res.status === 401 || res.status === 403) {
      // The cached key is now suspect: if the secret was rotated after this container
      // cached it, every later turn in the session would fail the same way. Drop it so
      // the next call re-reads the vault.
      if (provider) invalidateResourceApiKey(provider);
      // Never echo the body here — it can quote the credential we just sent.
      throw new ToolError(`Duffel rejected the access token (HTTP ${res.status})`);
    }
    if (!res.ok) {
      // Duffel returns structured errors; the title is safe to surface and helps the model.
      const detail = await res.json().catch(() => null) as any;
      const title = detail?.errors?.[0]?.title ?? detail?.errors?.[0]?.message;
      throw new ToolError(
        `Duffel returned HTTP ${res.status}${title ? `: ${title}` : ''}`,
        res.status >= 500,
      );
    }

    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ToolError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ToolError(`timeout after ${TIMEOUT_MS}ms calling the Duffel API`, true);
    }
    throw new ToolError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

export const duffelGet = <T>(path: string, params: Record<string, string> = {}): Promise<T> =>
  request<T>(`${path}?${new URLSearchParams(params)}`, { method: 'GET' });

export const duffelPost = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
