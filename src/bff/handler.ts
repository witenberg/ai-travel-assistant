import { createHash } from 'node:crypto';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { Trace } from '../observability/trace.js';
import { bearerToken, extractScopes } from '../auth/scopes.js';

/**
 * Backend for Frontend.
 *
 * ADR-0001: the answer returns synchronously through this Lambda instead of streaming
 * from the Runtime to the browser. The reason is the mapping below — turning a verified
 * JWT into a session id is a security control, and a control the client can reach is not
 * a control. That mapping is the whole justification for this component; everything else
 * here is plumbing.
 *
 * This function verifies nothing itself. API Gateway's Cognito authorizer has already
 * rejected the request if the token is missing, expired or from another pool, so by the
 * time we run, `requestContext.authorizer.claims` is trustworthy. Re-validating here
 * would be a second implementation of the same rule, free to drift from the first.
 */

/** AgentCore rejects session ids shorter than this. A sha256 hex digest is 64. */
const MIN_SESSION_ID_LENGTH = 33;

// Re-exported because the tests and the smoke script name it here; the rule itself is
// shared with the Gateway interceptor, so it lives in one place.
export { extractScopes };

/** Minimal shape of an API Gateway REST proxy event — only the fields we read. */
export interface ProxyEvent {
  body?: string | null;
  isBase64Encoded?: boolean;
  /**
   * Raw request headers. We read exactly one, `Authorization`, and only to forward the
   * caller's access token to the Runtime so AgentCore Gateway can authorize each tool call
   * against the user's own scopes (ADR-0004). It is never logged and never parsed here —
   * API Gateway has already validated it.
   */
  headers?: Record<string, string | undefined>;
  requestContext?: {
    requestId?: string;
    authorizer?: { claims?: Record<string, string | undefined> };
  };
}

export interface ProxyResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Session id derived from the token's `sub`, never from the request body.
 *
 * Hashed rather than used raw for two reasons: the id is written into AgentCore Memory
 * and into log lines that leave our account boundary, and a hash keeps the Cognito
 * identity from spreading into systems that have no reason to hold it. The cost is that
 * a session id can no longer be read backwards to a user during support — acceptable,
 * because the same mapping can always be recomputed from a known `sub`.
 */
export function deriveSessionId(sub: string): string {
  const digest = createHash('sha256').update(`travel-assistant:${sub}`).digest('hex');
  if (digest.length < MIN_SESSION_ID_LENGTH) throw new Error('derived session id is too short');
  return digest;
}

/**
 * Actor id derived from the same `sub`, with a different domain separator.
 *
 * A separate value rather than a reuse of the session id, even though both come from one
 * `sub` today. The two answer different questions — "which conversation" and "which
 * person" — and long-term memory is keyed on the second, so the day a real
 * per-conversation session id arrives, what the agent learned must not move with it.
 * Distinct strings also mean a log line naming one can never be mistaken for the other.
 */
export function deriveActorId(sub: string): string {
  // Leading letter: AgentCore requires an actor id to start alphanumeric.
  return `u-${createHash('sha256').update(`travel-assistant-actor:${sub}`).digest('hex')}`;
}

function respond(statusCode: number, body: unknown): ProxyResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function decodeBody(event: ProxyEvent): string {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

type Invoker = Pick<BedrockAgentCoreClient, 'send'>;

export interface HandlerDeps {
  client?: Invoker;
  runtimeArn?: string;
  qualifier?: string;
}

export function createHandler(deps: HandlerDeps = {}) {
  // Created once per container, not per request: the SDK client holds the connection
  // pool and the credential cache, and rebuilding it on every invocation adds latency
  // to a path that already has a ~29 s ceiling.
  const client = deps.client ?? new BedrockAgentCoreClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
  });

  return async function handler(event: ProxyEvent): Promise<ProxyResult> {
    const claims = event.requestContext?.authorizer?.claims ?? {};
    const sub = claims.sub;
    const runtimeArn = deps.runtimeArn ?? process.env.AGENT_RUNTIME_ARN;
    const qualifier = deps.qualifier ?? process.env.AGENT_ENDPOINT_NAME ?? 'DEFAULT';

    if (!runtimeArn) {
      console.error(JSON.stringify({ type: 'error', route: 'bff', message: 'AGENT_RUNTIME_ARN is not set' }));
      return respond(500, { error: 'agent runtime is not configured' });
    }

    // Only reachable if the authorizer is missing or misconfigured — a token without
    // `sub` cannot be mapped to a session, and guessing one would defeat the isolation.
    if (!sub) return respond(401, { error: 'token carries no subject' });

    const sessionId = deriveSessionId(sub);
    const actorId = deriveActorId(sub);
    const trace = new Trace(sessionId);

    let payload: { prompt?: unknown; sessionId?: unknown; scopes?: unknown; actorId?: unknown };
    try {
      payload = JSON.parse(decodeBody(event) || '{}');
    } catch (err) {
      return respond(400, { error: `invalid JSON body: ${(err as Error).message}` });
    }

    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
    if (!prompt) return respond(400, { error: 'field "prompt" is required' });

    // A client that sends its own sessionId, actorId or scopes is attempting to read
    // another user's Memory or to widen its own permissions. `actorId` is the newest and
    // the most valuable of the three: a session holds one conversation, an actor holds
    // everything the agent has ever learned about a person. We never read those fields,
    // but we record the attempt — silently ignoring it would leave no evidence it happened.
    if (payload.sessionId !== undefined || payload.actorId !== undefined || payload.scopes !== undefined) {
      trace.blocked('bff.client_supplied_identity', {
        suppliedSessionId: payload.sessionId !== undefined,
        suppliedActorId: payload.actorId !== undefined,
        suppliedScopes: payload.scopes !== undefined,
        decision: 'ignored',
      });
    }

    // The token itself, not its claims: the Gateway needs a bearer it can validate on its
    // own, and the claims API Gateway parsed for us cannot be turned back into one.
    const accessToken = bearerToken(event.headers);
    if (!accessToken) {
      // Unreachable through the authorizer, which rejects a request with no bearer. Reached
      // only if the method is wired without one, and then the agent's Gateway calls would
      // fail one layer deeper with a far less obvious message.
      trace.blocked('bff.authorize', { decision: 'deny', reason: 'no bearer token on the request' });
      return respond(401, { error: 'request carries no bearer token' });
    }

    const scopes = extractScopes(claims.scope);
    if (scopes.length === 0) {
      // Fail closed, and fail before Bedrock. Every tool would be blocked downstream
      // anyway, so invoking the model here would spend budget to produce an apology.
      trace.blocked('bff.authorize', { grantedScopes: [], decision: 'deny' });
      return respond(403, { error: 'token grants no tool scopes' });
    }

    try {
      const result = await trace.span('bff.invoke_runtime', { runtimeArn, qualifier, scopes }, () =>
        client.send(new InvokeAgentRuntimeCommand({
          agentRuntimeArn: runtimeArn,
          qualifier,
          runtimeSessionId: sessionId,
          contentType: 'application/json',
          accept: 'application/json',
          payload: new TextEncoder().encode(
            JSON.stringify({ prompt, scopes, actorId, accessToken }),
          ),
        })),
      );

      const raw = await result.response?.transformToString();
      const answer = raw ? JSON.parse(raw) : {};

      return respond(200, {
        response: answer.response ?? '',
        sessionId,
        traceId: answer.traceId ?? trace.traceId,
        toolCalls: answer.toolCalls ?? [],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ type: 'error', route: 'bff', sessionId, message }));
      // 502, not 500: the failure is upstream in the Runtime, and the distinction is
      // what tells us at 3 a.m. whether to look at this function or at AgentCore.
      return respond(502, { error: 'the agent runtime did not answer', detail: message });
    }
  };
}

export const handler = createHandler();
