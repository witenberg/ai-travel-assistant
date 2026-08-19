import { GATEWAY_TOOLS, type Tool } from '../tools/index.js';
import { stripTargetPrefix } from './naming.js';
import { bearerToken, decodeJwtClaims, extractScopes } from '../auth/scopes.js';
import { Trace } from '../observability/trace.js';

/**
 * REQUEST interceptor for AgentCore Gateway: per-tool scope enforcement.
 *
 * This is the component the second FigJam diagram draws — `Request -> IdP (Cognito,
 * scopes) -> Gateway -> search photo` — and the reason the Gateway is in the architecture
 * at all. Everything the Gateway does for us that a direct Lambda call would not: it
 * validated the caller's JWT before this function ran, and it will refuse the tool call
 * because this function says so, without our agent's code being involved in the decision.
 *
 * `src/guard.ts` holds the same rule for local runs. The two are deliberately separate
 * implementations of one policy, and the tool registry is the single source both read
 * `requiredScope` from — so a scope changed on a tool changes both at once.
 *
 * A REQUEST interceptor runs on **every** gateway call, including `initialize` and
 * `tools/list`. Anything that is not a `tools/call` is passed through untouched.
 */

/** Contract version required by the interceptor API, in and out. */
const INTERCEPTOR_VERSION = '1.0';

/**
 * Our own header, set by the agent's MCP client, carrying the runtime session id.
 *
 * It exists so a denial recorded here lands in the same `Session -> trace -> span`
 * hierarchy as the spans the Runtime writes. AgentCore does not forward its session id
 * across the Gateway, so without this the blocked span would be an orphan: correct, and
 * impossible to attach to the conversation that caused it.
 */
export const SESSION_HEADER = 'x-travel-session-id';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { name?: string; arguments?: unknown };
}

export interface InterceptorInput {
  interceptorInputVersion?: string;
  mcp?: {
    rawGatewayRequest?: { body?: string };
    gatewayRequest?: {
      path?: string;
      httpMethod?: string;
      headers?: Record<string, string | undefined>;
      body?: JsonRpcRequest;
    };
  };
}

export interface InterceptorOutput {
  interceptorOutputVersion: string;
  mcp: {
    transformedGatewayRequest?: { body: unknown };
    transformedGatewayResponse?: { statusCode: number; body: unknown };
  };
}

/**
 * Lets the request through unchanged.
 *
 * Echoes the original body rather than returning an empty `mcp` object. The docs spell out
 * the empty-object pass-through for HTTP targets but not for MCP ones, and an explicit
 * identity transform cannot be wrong either way.
 */
const passThrough = (body: unknown): InterceptorOutput => ({
  interceptorOutputVersion: INTERCEPTOR_VERSION,
  mcp: { transformedGatewayRequest: { body } },
});

/**
 * Answers the caller instead of the tool.
 *
 * Shaped as a JSON-RPC *success* carrying `isError: true`, not as a JSON-RPC error. That
 * distinction is the whole user-visible behaviour of a denial: an MCP tool error arrives
 * at the model as a failed `tool_result`, so the model reads the reason and tells the user
 * honestly what it may not do — the same answer the local `guard.ts` path produces. A
 * protocol-level error would surface as a broken tool call instead, and the turn would end
 * in an apology about a technical fault that did not happen.
 *
 * The payload is JSON with `blocked: true` so the client can tell a refusal from a
 * malfunction structurally, rather than by matching on wording we might reword later.
 */
const deny = (id: JsonRpcRequest['id'], reason: string): InterceptorOutput => ({
  interceptorOutputVersion: INTERCEPTOR_VERSION,
  mcp: {
    transformedGatewayResponse: {
      // 200: the HTTP exchange succeeded and the JSON-RPC envelope is valid. The refusal
      // lives in the payload, which is where MCP puts tool-level outcomes.
      statusCode: 200,
      body: {
        jsonrpc: '2.0',
        id: id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ error: reason, blocked: true }) }],
          isError: true,
        },
      },
    },
  },
});

export function createInterceptorHandler(tools: readonly Tool[] = GATEWAY_TOOLS) {
  return async function handler(input: InterceptorInput): Promise<InterceptorOutput> {
    const request = input.mcp?.gatewayRequest;
    const body = request?.body;
    const headers = request?.headers;

    // Not a tool invocation — `initialize`, `notifications/initialized`, `tools/list`.
    // There is nothing to authorize, and `tools/list` is deliberately *not* filtered:
    // hiding a tool the caller may not use would remove the very denial the observability
    // requirement is about, and would trade a readable refusal for a model that silently
    // never knows the capability exists.
    if (body?.method !== 'tools/call') return passThrough(body);

    const advertisedName = body.params?.name ?? '';
    const name = stripTargetPrefix(advertisedName);

    const sessionId = headerValue(headers, SESSION_HEADER) ?? 'unknown';
    const trace = new Trace(sessionId);

    const token = bearerToken(headers);
    const claims = token ? decodeJwtClaims(token) : undefined;
    const grantedScopes = extractScopes(typeof claims?.scope === 'string' ? claims.scope : undefined);

    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      // Fail closed. A tool the Gateway serves but this function does not know cannot have
      // its required scope looked up, and "unknown, therefore allowed" is how a target
      // added without a matching code change ends up with no authorization at all.
      trace.blocked('gateway.authorize', {
        tool: name, decision: 'deny', reason: 'unknown tool', grantedScopes,
      });
      return deny(body.id, `Tool "${name}" is not recognised by the gateway interceptor.`);
    }

    if (!token || !claims) {
      // Also fail closed. The Gateway validated a JWT before invoking us, so a request
      // reaching here without a readable one means `passRequestHeaders` is off or the
      // payload contract changed — either way we cannot make the decision we exist to make.
      trace.blocked('gateway.authorize', {
        tool: name, requiredScope: tool.requiredScope, decision: 'deny', reason: 'no readable bearer token',
      });
      return deny(body.id, `Cannot authorize ${name}: the request carried no readable access token.`);
    }

    if (!grantedScopes.includes(tool.requiredScope)) {
      // The span from the diagram: interceptor caught it, call was blocked. It is written
      // here rather than in the agent because here is where the decision is actually made.
      trace.blocked('gateway.authorize', {
        tool: name,
        requiredScope: tool.requiredScope,
        grantedScopes,
        decision: 'deny',
        // Which client asked, for the audit trail. Never the token itself.
        clientId: typeof claims.client_id === 'string' ? claims.client_id : undefined,
      });
      return deny(body.id, `Missing scope "${tool.requiredScope}" required by ${name}.`);
    }

    trace.ok('gateway.authorize', { tool: name, requiredScope: tool.requiredScope, decision: 'allow' });
    return passThrough(body);
  };
}

const headerValue = (
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined =>
  headers
    ? Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]
    : undefined;

export const handler = createInterceptorHandler();
