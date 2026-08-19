import { stripTargetPrefix } from './naming.js';
import { SESSION_HEADER } from './interceptor.js';
import { Trace } from '../observability/trace.js';

/**
 * RESPONSE interceptor for AgentCore Gateway: the outbound half of the FigJam diagram.
 *
 * The board draws `interceptors inbound` **and** `interceptors outbound`; until now only
 * the inbound one existed. This one closes a real hole rather than decorating the diagram:
 * **the target Lambda cannot know the session id.** AgentCore forwards none, and our own
 * `x-travel-session-id` header reaches interceptors but not targets, so a tool-execution
 * span written inside the target could never be attached to the conversation that caused
 * it. A RESPONSE interceptor sees the original request headers *and* the response, which
 * makes it the one place where a tool's outcome and a session id meet.
 *
 * It observes and never transforms. Redaction is where this would grow if a tool ever
 * returned something the model must not be handed — the mechanism is the same, only the
 * return value differs — but transforming a response with no reason to would be a change
 * nobody could justify at review.
 *
 * Two consequences of the contract, both from the docs and both load-bearing here:
 *
 *   - **A denial still reaches this function.** For MCP targets, "if the REQUEST
 *     interceptor output contains a `transformedGatewayResponse`, the RESPONSE interceptor
 *     will still be invoked." So a scope refusal appears twice — once as
 *     `gateway.authorize` `blocked`, once here — and this span has to report it as blocked
 *     rather than as a tool that ran and failed, or every denial would look like an outage.
 *   - **The gateway may retry an interceptor.** The docs ask for idempotency. Writing a
 *     span is not idempotent in the strict sense, but it is harmless to repeat: a duplicate
 *     span is a duplicate observation, not a duplicate effect.
 */

const INTERCEPTOR_VERSION = '1.0';

interface JsonRpcRequest {
  id?: number | string | null;
  method?: string;
  params?: { name?: string; arguments?: unknown };
}

interface McpContent {
  type?: string;
  text?: string;
}

interface JsonRpcResponse {
  id?: number | string | null;
  result?: { content?: McpContent[]; isError?: boolean; tools?: unknown[] };
  error?: { code?: number; message?: string };
}

export interface ResponseInterceptorInput {
  interceptorInputVersion?: string;
  mcp?: {
    rawGatewayRequest?: { body?: string };
    gatewayRequest?: {
      path?: string;
      httpMethod?: string;
      headers?: Record<string, string | undefined>;
      body?: JsonRpcRequest;
    };
    gatewayResponse?: {
      statusCode?: number;
      headers?: Record<string, string | undefined>;
      isStreamingResponse?: boolean;
      body?: JsonRpcResponse;
    };
  };
}

export interface ResponseInterceptorOutput {
  interceptorOutputVersion: string;
  mcp: {
    transformedGatewayResponse?: {
      statusCode?: number;
      headers?: Record<string, string | undefined>;
      body: unknown;
    };
  };
}

/**
 * Passes the response through unchanged, by echoing it back as an identity transform.
 *
 * **This cost a deploy, and the mistake was reading one target type's rule as the other's.**
 * The docs state the empty-object pass-through — `{"interceptorOutputVersion":"1.0","http":{}}`
 * — for **HTTP** targets only. For an MCP target, returning an empty `mcp` object does not
 * mean "change nothing": the gateway answered the caller with an empty body, so `tools/list`
 * and every `tools/call` came back `{}` while the interceptor's own spans showed the calls
 * succeeding. The agent then failed its handshake and the turn died with a 500.
 *
 * The inbound interceptor had it right all along, and for the same reason: it echoes the
 * request body rather than trusting a rule written for a different payload shape. An explicit
 * identity transform cannot be misread by either side.
 *
 * **And an identity transform has to include the headers.** Echoing only `statusCode` and
 * `body` — which is all the docs' MCP example shows — cost a second deploy: the response to
 * `initialize` carries `Mcp-Session-Id`, so dropping headers loses the MCP session and the
 * *next* request fails with `HTTP 400: {}`. The symptom appears one call away from the cause
 * and only for a client that does a handshake, which is why the smoke script's raw JSON-RPC
 * calls kept passing while the agent could not list a single tool.
 */
const passThrough = (
  response: { statusCode?: number; headers?: Record<string, string | undefined>; body?: unknown } | undefined,
): ResponseInterceptorOutput => {
  // Nothing to echo means there was no response to preserve in the first place — a malformed
  // event, not a real tool result. An empty `mcp` is then the only thing left to return.
  if (!response || response.body === undefined) {
    return { interceptorOutputVersion: INTERCEPTOR_VERSION, mcp: {} };
  }
  return {
    interceptorOutputVersion: INTERCEPTOR_VERSION,
    mcp: {
      transformedGatewayResponse: {
        statusCode: response.statusCode ?? 200,
        // `Mcp-Session-Id` lives here. See the note above: this line is the fix for a failure
        // that surfaced as a broken `tools/list` one request later.
        ...(response.headers ? { headers: response.headers } : {}),
        body: response.body,
      },
    },
  };
};

const headerValue = (
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined =>
  headers
    ? Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]
    : undefined;

/** Our denials carry `blocked: true` structurally, so this does not match on wording. */
function isBlocked(content: McpContent[] | undefined): boolean {
  for (const part of content ?? []) {
    if (typeof part.text !== 'string') continue;
    try {
      if ((JSON.parse(part.text) as { blocked?: unknown }).blocked === true) return true;
    } catch {
      // Tool output is normally JSON, but nothing in the protocol requires it. Text that
      // is not JSON simply is not a denial marker.
    }
  }
  return false;
}

/** Size of what actually went back to the model — the cheapest proxy for token cost. */
const responseBytes = (body: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(body ?? null), 'utf8');
  } catch {
    return -1;
  }
};

export function createResponseInterceptorHandler() {
  return async function handler(input: ResponseInterceptorInput): Promise<ResponseInterceptorOutput> {
    // Read before anything else can throw: whatever happens below, the caller gets its
    // response back. This function observes; it must never be the reason an answer is lost.
    const original = input.mcp?.gatewayResponse;
    try {
      const request = input.mcp?.gatewayRequest;
      const response = input.mcp?.gatewayResponse;
      const method = request?.body?.method;

      // The session id our MCP client sent. `unknown` rather than a fabricated id: a span
      // that cannot be attached to a conversation should say so, not invent a home.
      const sessionId = headerValue(request?.headers, SESSION_HEADER) ?? 'unknown';
      const trace = new Trace(sessionId);

      /*
       * What the response stage actually sees, one line per gateway call.
       *
       * Kept because it is the only window into this contract: the payload the docs describe
       * and the payload a real MCP gateway sends have already differed twice here. Header
       * *names* plus the MCP session id — which is a correlation id the gateway itself hands
       * out, not a credential, and which our own spans already carry. The bearer token is
       * never touched.
       */
      console.error(JSON.stringify({
        type: 'diagnostic',
        event: 'response_stage',
        method: method ?? null,
        statusCode: response?.statusCode ?? null,
        responseHeaders: Object.keys(response?.headers ?? {}),
        mcpSessionId: headerValue(response?.headers, 'mcp-session-id') ?? null,
      }));

      if (method === 'tools/call') {
        const name = stripTargetPrefix(request?.body?.params?.name ?? '');
        const result = response?.body?.result;
        const blocked = isBlocked(result?.content);

        const attributes = {
          tool: name,
          statusCode: response?.statusCode,
          bytes: responseBytes(response?.body),
          // The JSON-RPC id is a per-connection counter, not a correlation key. It is here
          // as an attribute for lining up request and response within one conversation,
          // which is the only thing it can honestly do.
          mcpMessageId: response?.body?.id ?? request?.body?.id ?? null,
          streaming: response?.body === undefined ? undefined : Boolean(response?.isStreamingResponse),
        };

        if (blocked) {
          // The refusal the inbound interceptor produced, observed on its way out. Recorded
          // as blocked so a denial is never counted as a tool failure.
          trace.blocked('gateway.tool.response', { ...attributes, decision: 'deny' });
        } else if (result?.isError || response?.body?.error) {
          // A genuine tool failure: the target ran and reported an error. Distinguishing
          // this from a denial is the entire reason this span exists on the outbound leg.
          trace.error('gateway.tool.response', {
            ...attributes,
            reason: response?.body?.error?.message ?? 'tool reported isError',
          });
        } else {
          trace.ok('gateway.tool.response', attributes);
        }
      } else if (method === 'tools/list') {
        // Cheap and worth having: the catalogue is what the model is told it can do, and a
        // shrunken catalogue is the failure mode ADR-0004 refuses to allow silently.
        trace.ok('gateway.tools_list.response', {
          tools: response?.body?.result?.tools?.length ?? 0,
          statusCode: response?.statusCode,
        });
      }
    } catch (err) {
      // Never fail the response. This function is telemetry on the path of every tool
      // result; a bug here must not cost the user an answer, so the worst case is a missing
      // span and a line saying why.
      console.error(JSON.stringify({
        type: 'error',
        component: 'gateway.response_interceptor',
        message: err instanceof Error ? err.message : String(err),
      }));
    }

    return passThrough(original);
  };
}

export const handler = createResponseInterceptorHandler();
