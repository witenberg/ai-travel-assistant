import { ToolError } from '../types.js';

/**
 * Duffel API client.
 *
 * This is the only tool in the project that needs outbound authentication, which is
 * why it exists: the diagram's `outbound (API key / OAuth 2)` edge through AgentCore
 * Identity had nothing to enforce while every tool was keyless.
 *
 * Duffel uses a static bearer token rather than an OAuth 2 exchange, so there is no
 * token lifecycle to manage — the secret goes straight into the Authorization header.
 * After deployment the secret is what AgentCore Identity injects on the outbound leg;
 * nothing else about this module changes.
 */

const BASE_URL = process.env.DUFFEL_BASE_URL ?? 'https://api.duffel.com';
const API_VERSION = 'v2';
const TIMEOUT_MS = 15_000;

export function hasCredentials(): boolean {
  return Boolean(process.env.DUFFEL_ACCESS_TOKEN);
}

function authHeaders(): Record<string, string> {
  const token = process.env.DUFFEL_ACCESS_TOKEN;
  if (!token) {
    throw new ToolError('Flight search is not configured: DUFFEL_ACCESS_TOKEN is missing.');
  }
  return {
    authorization: `Bearer ${token}`,
    'Duffel-Version': API_VERSION,
    accept: 'application/json',
  };
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { ...authHeaders(), ...init.headers },
    });

    if (res.status === 401 || res.status === 403) {
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
