import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { runAgent, type AgentResult } from './agent.js';
import { ALL_SCOPES } from './guard.js';
import { memoryStoreFromEnv, type MemoryStore } from './memory/store.js';

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

export function createServer(deps: { runAgent?: AgentRunner; memory?: MemoryStore } = {}) {
  const agent = deps.runAgent ?? runAgent;
  // Built once per container, not per request: the store owns an SDK client, and the
  // connection pool and credential cache are the whole reason to keep it alive.
  const memory = deps.memory ?? memoryStoreFromEnv();
  const health = new HealthState();

  return createHttpServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && url === '/ping') {
      return sendJson(res, 200, health.snapshot());
    }

    if (req.method !== 'POST' || url !== '/invocations') {
      return sendJson(res, 404, { error: `no route for ${req.method} ${url}` });
    }

    health.enter();
    try {
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

      const result: AgentResult = await agent(prompt, {
        sessionId,
        actorId: payload.actorId ?? sessionId,
        scopes: payload.scopes ?? [...ALL_SCOPES],
        memory,
      });

      return sendJson(res, 200, {
        response: result.answer,
        status: 'success',
        sessionId,
        traceId: result.traceId,
        toolCalls: result.toolCalls,
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
