import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { runAgent, type AgentResult } from './agent.js';
import { ALL_SCOPES } from './guard.js';
import { memoryStoreFromEnv, type MemoryStore } from './memory/store.js';
import { LOCAL_TOOLS, TOOLS } from './tools/index.js';
import { CompositeToolProvider, LocalToolProvider, type ToolProvider } from './tools/provider.js';
import { GatewayToolProvider, type ToolSpecCache } from './tools/gatewayProvider.js';
import { McpClient } from './mcp/client.js';
import { SESSION_HEADER as GATEWAY_SESSION_HEADER } from './gateway/interceptor.js';
import { runWithWorkloadToken, workloadTokenFromHeaders } from './identity/workloadToken.js';
import { Trace } from './observability/trace.js';

/**
 * AgentCore Runtime HTTP service contract.
 *
 * Requirements taken from the AWS docs (runtime-http-protocol-contract):
 *   host 0.0.0.0, port 8080, ARM64 container,
 *   POST /invocations  -> JSON in, JSON out
 *   GET  /ping         -> {"status": "Healthy" | "HealthyBusy"}
 *
 * Built on node:http rather than a framework: two routes do not justify a dependency,
 * and a smaller image builds faster for ARM64.
 */

const PORT = Number(process.env.PORT ?? 8080);
const HOST = '0.0.0.0';

/** AgentCore passes the session id in this header. */
const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';

/** Requests larger than this are rejected before we buffer them. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * The header *names* AgentCore sends us, recorded once per container.
 *
 * Written for ROADMAP step 2, and it stays. What the Runtime injects into the container
 * is not something we control or can read from the outside, and the whole reason step 2
 * had an open unknown is that nobody had looked. Names are safe to log; values are not,
 * and one of these headers is a live workload access token — so this logs `Object.keys`
 * and never the object.
 */
let headerNamesLogged = false;
function logInboundHeaderNames(headers: NodeJS.Dict<string | string[]>, tokenHeader?: string): void {
  if (headerNamesLogged) return;
  headerNamesLogged = true;
  console.error(JSON.stringify({
    type: 'diagnostic',
    event: 'invocation_headers',
    names: Object.keys(headers).sort(),
    workloadTokenHeader: tokenHeader ?? null,
  }));
}

type AgentRunner = typeof runAgent;

interface InvocationPayload {
  prompt?: string;
  scopes?: string[];
  /**
   * The person behind the session, derived by the BFF from the verified JWT.
   *
   * Server-supplied, exactly like `scopes`: only the BFF holds `InvokeAgentRuntime` and
   * the Runtime is not publicly reachable, so this channel carries the same trust the
   * scope list already does. A client cannot reach it, which is the property that makes
   * reading another actor's long-term memory impossible.
   */
  actorId?: string;
  /**
   * The caller's Cognito access token, forwarded verbatim by the BFF.
   *
   * The agent does not read it — it hands it to AgentCore Gateway as the MCP bearer, so
   * the Gateway authorizes each tool call against the *user's* scopes. The alternative was
   * an M2M token belonging to the agent itself, which would have made per-user
   * authorization at the Gateway impossible; see ADR-0004.
   *
   * Server-supplied like `scopes` and `actorId`: only the BFF holds `InvokeAgentRuntime`.
   */
  accessToken?: string;
}

/**
 * Chooses where tools come from, once per turn.
 *
 * Three cases, and the middle one is the security-relevant one:
 *   - no `GATEWAY_URL`: everything runs in process under `guard.ts`. This is `npm run dev`
 *     and every test.
 *   - `GATEWAY_URL` set but no access token: refuse the turn. Falling back to in-process
 *     execution would look like resilience and would in fact bypass the authorization we
 *     deployed the Gateway to perform.
 *   - both present: the Gateway serves its tools and `search_flights` stays local, because
 *     its credential comes from the Identity token vault (ADR-0002).
 */
export function buildToolProvider(args: {
  scopes: readonly string[];
  accessToken?: string;
  sessionId: string;
  gatewayUrl?: string;
  specCache?: ToolSpecCache;
}): ToolProvider {
  const gatewayUrl = args.gatewayUrl ?? process.env.GATEWAY_URL;
  if (!gatewayUrl) return new LocalToolProvider(TOOLS, args.scopes);

  if (!args.accessToken) {
    throw new Error('GATEWAY_URL is configured but the invocation carried no access token');
  }

  const client = new McpClient({
    url: gatewayUrl,
    accessToken: args.accessToken,
    // Carries the session id across the Gateway so a denial recorded by the interceptor
    // belongs to the same Session -> trace -> span hierarchy as the rest of the turn.
    extraHeaders: { [GATEWAY_SESSION_HEADER]: args.sessionId },
  });

  return new CompositeToolProvider([
    new GatewayToolProvider(client, args.specCache),
    new LocalToolProvider(LOCAL_TOOLS, args.scopes),
  ]);
}

/**
 * Ping health state.
 *
 * `time_of_last_update` is set only when the status actually changes. The AWS docs are
 * explicit that advancing this timestamp on every ping signals a continuous status
 * change, which stops the idle session timeout from ever firing — sessions then live
 * until MaxLifetime and exhaust the session quota. On a 10 USD budget that is not an
 * abstract concern, so we track the change ourselves.
 */
class HealthState {
  private status: 'Healthy' | 'HealthyBusy' = 'Healthy';
  private changedAt = Math.floor(Date.now() / 1000);
  private inFlight = 0;

  enter(): void { this.inFlight++; this.sync(); }
  leave(): void { this.inFlight = Math.max(this.inFlight - 1, 0); this.sync(); }

  private sync(): void {
    const next = this.inFlight > 0 ? 'HealthyBusy' : 'Healthy';
    if (next !== this.status) {
      this.status = next;
      this.changedAt = Math.floor(Date.now() / 1000);
    }
  }

  snapshot(): { status: string; time_of_last_update: number } {
    return { status: this.status, time_of_last_update: this.changedAt };
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createServer(
  deps: { runAgent?: AgentRunner; memory?: MemoryStore; tools?: ToolProvider } = {},
) {
  const agent = deps.runAgent ?? runAgent;
  // Built once per container, not per request: the store owns an SDK client, and the
  // connection pool and credential cache are the whole reason to keep it alive.
  const memory = deps.memory ?? memoryStoreFromEnv();
  const health = new HealthState();
  // Container-scoped: the Gateway's tool catalogue is the same for every caller, so the
  // `tools/list` round trip is paid once per container rather than once per turn.
  const specCache: ToolSpecCache = {};

  return createHttpServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && url === '/ping') {
      return sendJson(res, 200, health.snapshot());
    }

    if (req.method !== 'POST' || url !== '/invocations') {
      return sendJson(res, 404, { error: `no route for ${req.method} ${url}` });
    }

    health.enter();
    // AgentCore hands the workload access token to the container on the invocation
    // itself (see identity/workloadToken.ts). Picked up here, at the only place it
    // arrives, and made available to the turn rather than passed through five signatures.
    const workload = workloadTokenFromHeaders(req.headers);
    logInboundHeaderNames(req.headers, workload?.header);
    try {
      return await runWithWorkloadToken(workload?.token, async () => {
        let payload: InvocationPayload;
        try {
          payload = JSON.parse(await readBody(req)) as InvocationPayload;
        } catch (err) {
          return sendJson(res, 400, { error: `invalid JSON body: ${(err as Error).message}` });
        }

        const prompt = payload.prompt?.trim();
        if (!prompt) return sendJson(res, 400, { error: 'field "prompt" is required' });

        // A session id from AgentCore is authoritative. The fallback exists only for
        // local runs; in production the BFF maps the user to a session before we see it.
        const sessionId = (req.headers[SESSION_HEADER] as string | undefined) ?? `local-${randomUUID()}`;

        const scopes = payload.scopes ?? [...ALL_SCOPES];

        let tools: ToolProvider;
        try {
          tools = deps.tools ?? buildToolProvider({
            scopes,
            accessToken: payload.accessToken,
            sessionId,
            specCache,
          });
        } catch (err) {
          // Fail closed and say so. A misconfigured Gateway must not degrade into local
          // execution, because local execution is the path whose authorization we moved away.
          new Trace(sessionId).blocked('agent.tool_provider', {
            decision: 'deny',
            reason: err instanceof Error ? err.message : String(err),
          });
          return sendJson(res, 403, { error: 'tools are unavailable for this request', status: 'error' });
        }

        const result: AgentResult = await agent(prompt, {
          sessionId,
          actorId: payload.actorId ?? sessionId,
          scopes,
          memory,
          tools,
        });

          return sendJson(res, 200, {
          response: result.answer,
          status: 'success',
          sessionId,
          traceId: result.traceId,
          toolCalls: result.toolCalls,
          /*
           * Which build answered. A session keeps its warm container across a deploy, so a
           * `200` right after one can come from the previous version — three deploys in a row
           * were verified against code that was not running before this field existed. CDK
           * sets it from the container image's asset hash, so it changes when the code does.
           */
          // Shortened here, not in CDK: at synth time the value is an unresolved token and
          // slicing it yields a fragment of the placeholder. At runtime it is a real string.
          build: (process.env.AGENT_BUILD ?? 'local').slice(0, 12),
        });
      });
    } catch (err) {
      // AgentCore surfaces any container 4xx/5xx to the caller as 424 RuntimeClientError,
      // so the detail must reach CloudWatch from here — it will not survive the wrapper.
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ type: 'error', route: '/invocations', message }));
      return sendJson(res, 500, { error: message, status: 'error' });
    } finally {
      health.leave();
    }
  });
}

/** Only start listening when run directly, so tests can import createServer freely. */
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.error(`agent listening on http://${HOST}:${PORT}`);
  });

  // Containers are stopped with SIGTERM; finish in-flight turns instead of dropping them.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      console.error(`received ${signal}, shutting down`);
      server.close(() => process.exit(0));
    });
  }
}
