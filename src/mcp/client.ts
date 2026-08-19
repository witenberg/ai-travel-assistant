/**
 * Minimal MCP client over Streamable HTTP.
 *
 * AgentCore Gateway *is* an MCP server — that is the whole product claim — so reaching it
 * means speaking MCP rather than calling an AWS API. There is no `InvokeGatewayTool` SDK
 * call to hide behind, which is the point worth learning here.
 *
 * Hand-rolled rather than `@modelcontextprotocol/sdk`, for three reasons:
 *   - we need exactly three methods (`initialize`, `tools/list`, `tools/call`), and the
 *     wire format is JSON-RPC 2.0 over one POST;
 *   - the container image is rebuilt on every deploy and pulled on every cold start, so a
 *     dependency tree we do not need is paid for in image size and startup;
 *   - the SDK's transport does its own session and reconnect handling, which would sit
 *     between us and the one thing we are trying to observe.
 *
 * The cost is honest: no notifications, no resources, no prompts, no reconnect. If this
 * agent ever needs server-initiated messages, take the SDK and delete this file.
 */

/** Protocol version we ask for. The server's answer wins; see `initialize`. */
const PREFERRED_PROTOCOL_VERSION = '2025-06-18';

/** No single MCP call may hang a turn — the whole turn has a ~29 s ceiling (ADR-0001). */
const DEFAULT_TIMEOUT_MS = 15_000;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * The result of `tools/call`.
 *
 * `isError: true` is a *tool* failure reported successfully by the protocol — the call
 * reached the tool (or an interceptor) and came back with bad news. That is different
 * from a transport or JSON-RPC error, which throws.
 */
export interface McpToolResult {
  content: Array<{ type?: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export class McpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'McpError';
  }
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface McpClientOptions {
  /** Full MCP endpoint, e.g. https://<id>.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp */
  url: string;
  /** Bearer token for inbound authorization. For us, the caller's Cognito access token. */
  accessToken: string;
  timeoutMs?: number;
  /**
   * Extra headers sent on every request. We use one, to carry the runtime session id to
   * the Gateway interceptor — AgentCore does not forward its own session id across the
   * Gateway, so a denial recorded there would otherwise have nothing to attach it to.
   */
  extraHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export class McpClient {
  private readonly url: string;
  private readonly accessToken: string;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  private nextId = 1;
  private sessionId?: string;
  private protocolVersion = PREFERRED_PROTOCOL_VERSION;
  private handshake?: Promise<void>;

  constructor(opts: McpClientOptions) {
    this.url = opts.url;
    this.accessToken = opts.accessToken;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Performs the MCP handshake at most once per client.
   *
   * Memoised on the promise rather than on a boolean: the agent may list tools and call
   * one concurrently, and two handshakes would leave two session ids where the server
   * expects one.
   */
  private connect(): Promise<void> {
    this.handshake ??= (async () => {
      const result = await this.rpc('initialize', {
        protocolVersion: PREFERRED_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ai-travel-assistant', version: '0.1.0' },
      });
      // Adopt whatever the server answered with. Sending a version it did not agree to
      // on every subsequent request is how a working client starts failing after a
      // service-side upgrade.
      if (typeof result?.protocolVersion === 'string') this.protocolVersion = result.protocolVersion;
      // Fire-and-forget by design: `notifications/initialized` has no id and no reply.
      await this.notify('notifications/initialized');
    })();
    return this.handshake;
  }

  async listTools(): Promise<McpTool[]> {
    await this.connect();
    const tools: McpTool[] = [];
    let cursor: string | undefined;

    // Paginated by the protocol. We have three tools, but a client that reads only the
    // first page is a bug that appears the day someone adds a fourth target.
    do {
      const result = await this.rpc('tools/list', cursor ? { cursor } : {});
      for (const tool of result?.tools ?? []) tools.push(tool as McpTool);
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : undefined;
    } while (cursor);

    return tools;
  }

  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    await this.connect();
    const result = await this.rpc('tools/call', { name, arguments: args ?? {} });
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      isError: result?.isError === true,
      structuredContent: result?.structuredContent,
    };
  }

  private async notify(method: string, params: unknown = {}): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, params }, { expectBody: false });
  }

  private async rpc(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: '2.0', id, method, params }, { expectBody: true });
    if (!response) throw new McpError(`${method} returned an empty response`);
    if (response.error) {
      throw new McpError(`${method} failed: ${response.error.message ?? 'unknown error'}`, response.error.code);
    }
    return response.result;
  }

  private async post(
    body: unknown,
    { expectBody }: { expectBody: boolean },
  ): Promise<JsonRpcResponse | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          ...this.extraHeaders,
          'content-type': 'application/json',
          // Both types: a Streamable HTTP server may answer a single request with either
          // a JSON body or a one-event SSE stream, and it chooses.
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${this.accessToken}`,
          'mcp-protocol-version': this.protocolVersion,
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        },
        body: JSON.stringify(body),
      });

      // The server assigns the session on the initialize response and expects it echoed
      // on every later request.
      const session = res.headers.get('mcp-session-id');
      if (session) this.sessionId = session;

      if (!res.ok) {
        // Deliberately does not include the response body. A 401 or 403 from the Gateway
        // is an authorization failure, and an authorization failure's body can quote the
        // token that was just sent — the same rule the Duffel client follows.
        const detail = res.status === 401 || res.status === 403 ? '' : `: ${(await res.text()).slice(0, 300)}`;
        throw new McpError(`MCP endpoint returned HTTP ${res.status}${detail}`);
      }

      const text = await res.text();
      if (!text.trim()) {
        if (expectBody) throw new McpError('MCP endpoint returned an empty body');
        return undefined;
      }

      return (res.headers.get('content-type') ?? '').includes('text/event-stream')
        ? parseSseEnvelope(text)
        : (JSON.parse(text) as JsonRpcResponse);
    } catch (err) {
      if (err instanceof McpError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new McpError(`MCP request timed out after ${this.timeoutMs}ms`);
      }
      throw new McpError(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Pulls the JSON-RPC message out of an SSE body.
 *
 * We issue one request and expect one reply, so the last `data:` payload that parses is
 * the answer. Progress notifications carry no `id` and are skipped rather than mistaken
 * for the result.
 */
export function parseSseEnvelope(body: string): JsonRpcResponse {
  const payloads: string[] = [];
  let current: string[] = [];

  for (const rawLine of body.split(/\r?\n/)) {
    if (rawLine === '') {
      if (current.length) payloads.push(current.join('\n'));
      current = [];
      continue;
    }
    if (rawLine.startsWith('data:')) current.push(rawLine.slice(5).trimStart());
  }
  if (current.length) payloads.push(current.join('\n'));

  for (const payload of payloads.reverse()) {
    try {
      const parsed = JSON.parse(payload) as JsonRpcResponse;
      if (parsed.id !== undefined && parsed.id !== null) return parsed;
    } catch {
      /* not JSON — keep looking */
    }
  }
  throw new McpError('SSE response carried no JSON-RPC message with an id');
}
