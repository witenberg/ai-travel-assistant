/** Agent tool contract. Deliberately independent of Bedrock — easier to test. */
export interface Tool<I = any, O = unknown> {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the input — passed straight into the Bedrock Converse toolSpec. */
  readonly inputSchema: Record<string, unknown>;
  /**
   * OAuth scope required to invoke this tool. In v1 this is only a declaration —
   * `guard.ts` enforces it. After deployment, AgentCore Gateway interceptors take over.
   */
  readonly requiredScope: string;
  execute(input: I): Promise<O>;
}

export class ToolError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Shared fetch with a timeout — no tool may hang a turn. */
export async function fetchJson<T>(
  url: string,
  timeoutMs = 5000,
  init: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { 'user-agent': 'ai-travel-assistant/0.1 (mentoring project)', ...init.headers },
    });
    if (!res.ok) throw new ToolError(`HTTP ${res.status} from ${new URL(url).host}`, res.status >= 500);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ToolError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ToolError(`timeout after ${timeoutMs}ms calling ${new URL(url).host}`, true);
    }
    throw new ToolError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}
