import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/server.js';
import type { AgentResult } from '../src/agent.js';

/** Records what the server passed to the agent, so we can assert on plumbing. */
let lastCall: { prompt: string; sessionId: string; scopes?: readonly string[] } | null = null;
let nextError: Error | null = null;

const fakeAgent = (async (prompt: string, opts: any): Promise<AgentResult> => {
  lastCall = { prompt, sessionId: opts.sessionId, scopes: opts.scopes };
  if (nextError) throw nextError;
  return { answer: `echo: ${prompt}`, messages: [], traceId: 'trace-test', toolCalls: [] };
}) as any;

const server = createServer({ runAgent: fakeAgent });
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/invocations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('GET /ping', () => {
  test('reports Healthy in the shape AgentCore expects', async () => {
    const res = await fetch(`${base}/ping`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body: any = await res.json();
    assert.equal(body.status, 'Healthy');
    assert.equal(typeof body.time_of_last_update, 'number');
  });

  test('the timestamp does not advance when the status has not changed', async () => {
    const first: any = await (await fetch(`${base}/ping`)).json();
    const second: any = await (await fetch(`${base}/ping`)).json();
    // A timestamp advancing on every ping keeps sessions alive until MaxLifetime
    // and exhausts the session quota — the AWS docs call this out explicitly.
    assert.equal(first.time_of_last_update, second.time_of_last_update);
  });
});

describe('POST /invocations', () => {
  test('runs the agent and returns the contract shape', async () => {
    const res = await post({ prompt: 'hello' });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.status, 'success');
    assert.equal(body.response, 'echo: hello');
    assert.equal(body.traceId, 'trace-test');
  });

  test('uses the AgentCore session id header when present', async () => {
    await post({ prompt: 'hi' }, { 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': 'session-from-agentcore' });
    assert.equal(lastCall!.sessionId, 'session-from-agentcore');
  });

  test('falls back to a generated session id locally', async () => {
    await post({ prompt: 'hi' });
    assert.match(lastCall!.sessionId, /^local-/);
  });

  test('passes scopes through to the guard', async () => {
    await post({ prompt: 'hi', scopes: ['weather:read'] });
    assert.deepEqual(lastCall!.scopes, ['weather:read']);
  });

  test('rejects a missing prompt with 400', async () => {
    const res = await post({});
    assert.equal(res.status, 400);
    assert.match((await res.json() as any).error, /prompt/);
  });

  test('rejects malformed JSON with 400', async () => {
    const res = await post('{not json');
    assert.equal(res.status, 400);
  });

  test('returns 500 with a message when the agent throws', async () => {
    nextError = new Error('bedrock unavailable');
    const res = await post({ prompt: 'hi' });
    nextError = null;
    assert.equal(res.status, 500);
    const body: any = await res.json();
    assert.equal(body.status, 'error');
    assert.match(body.error, /bedrock unavailable/);
  });
});

describe('routing', () => {
  test('unknown paths return 404', async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });

  test('GET on /invocations returns 404', async () => {
    assert.equal((await fetch(`${base}/invocations`)).status, 404);
  });
});
