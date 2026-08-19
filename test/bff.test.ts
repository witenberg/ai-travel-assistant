import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, deriveSessionId, extractScopes } from '../src/bff/handler.js';

/** Captures what the BFF asked the Runtime to do, so we can assert on the mapping. */
let lastInput: any = null;
let nextError: Error | null = null;
let agentAnswer: unknown = { response: 'ok', traceId: 'trace-runtime', toolCalls: [] };

const fakeClient = {
  async send(command: any) {
    lastInput = command.input;
    if (nextError) throw nextError;
    return {
      response: { transformToString: async () => JSON.stringify(agentAnswer) },
    };
  },
} as any;

const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:687222805898:runtime/travel_assistant-test';

const handler = createHandler({ client: fakeClient, runtimeArn: RUNTIME_ARN });

const SUB = '9f3c1a20-0000-4000-8000-000000000001';

const invoke = (body: unknown, claims: Record<string, string> = {}) =>
  handler({
    body: typeof body === 'string' ? body : JSON.stringify(body),
    requestContext: { authorizer: { claims: { sub: SUB, scope: 'tools/weather:read', ...claims } } },
  });

beforeEach(() => { lastInput = null; nextError = null; });

describe('session mapping', () => {
  test('derives a session id long enough for AgentCore', () => {
    assert.ok(deriveSessionId(SUB).length >= 33);
  });

  test('is deterministic per subject and distinct across subjects', () => {
    assert.equal(deriveSessionId(SUB), deriveSessionId(SUB));
    assert.notEqual(deriveSessionId(SUB), deriveSessionId('another-subject'));
  });

  test('never leaks the raw subject into the session id', () => {
    assert.ok(!deriveSessionId(SUB).includes(SUB));
  });

  test('the runtime receives the derived session id', async () => {
    await invoke({ prompt: 'What is the weather in Lisbon?' });
    assert.equal(lastInput.runtimeSessionId, deriveSessionId(SUB));
  });

  // The reason the BFF exists: a client-supplied session id would read another
  // user's Memory. See ADR-0001.
  test('a client-supplied sessionId is ignored, not honoured', async () => {
    const res = await invoke({ prompt: 'hi', sessionId: 'a'.repeat(40) });
    assert.equal(res.statusCode, 200);
    assert.equal(lastInput.runtimeSessionId, deriveSessionId(SUB));
  });

  test('client-supplied scopes cannot widen the token', async () => {
    await invoke(
      { prompt: 'hi', scopes: ['flights:read', 'photos:search'] },
      { scope: 'tools/weather:read' },
    );
    const sent = JSON.parse(new TextDecoder().decode(lastInput.payload));
    assert.deepEqual(sent.scopes, ['weather:read']);
  });
});

describe('scope extraction', () => {
  test('strips the resource server prefix', () => {
    assert.deepEqual(extractScopes('tools/weather:read tools/photos:search'), ['weather:read', 'photos:search']);
  });

  test('drops scopes that are not tool permissions', () => {
    assert.deepEqual(extractScopes('openid email aws.cognito.signin.user.admin'), []);
  });

  test('drops unknown scopes that merely carry the prefix', () => {
    assert.deepEqual(extractScopes('tools/admin:everything tools/weather:read'), ['weather:read']);
  });

  test('treats a missing claim as no permissions', () => {
    assert.deepEqual(extractScopes(undefined), []);
  });
});

describe('request handling', () => {
  test('rejects a request with no prompt', async () => {
    const res = await invoke({});
    assert.equal(res.statusCode, 400);
    assert.equal(lastInput, null);
  });

  test('rejects a malformed body', async () => {
    const res = await invoke('{ not json');
    assert.equal(res.statusCode, 400);
  });

  test('rejects a token without a subject', async () => {
    const res = await handler({ body: JSON.stringify({ prompt: 'hi' }), requestContext: { authorizer: { claims: {} } } });
    assert.equal(res.statusCode, 401);
  });

  // Fails closed *before* Bedrock: an invocation that can use no tool still costs money.
  test('refuses a token with no tool scopes without invoking the runtime', async () => {
    const res = await invoke({ prompt: 'hi' }, { scope: 'openid' });
    assert.equal(res.statusCode, 403);
    assert.equal(lastInput, null);
  });

  test('passes the prompt through and returns the answer', async () => {
    agentAnswer = { response: 'Lisbon is sunny.', traceId: 'trace-runtime', toolCalls: [{ name: 'get_weather', blocked: false }] };
    const res = await invoke({ prompt: 'Weather in Lisbon?' });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.response, 'Lisbon is sunny.');
    assert.equal(body.traceId, 'trace-runtime');
    assert.deepEqual(body.toolCalls, [{ name: 'get_weather', blocked: false }]);
    const sent = JSON.parse(new TextDecoder().decode(lastInput.payload));
    assert.equal(sent.prompt, 'Weather in Lisbon?');
  });

  test('reports a runtime failure as 502, not 500', async () => {
    nextError = new Error('runtime unavailable');
    const res = await invoke({ prompt: 'hi' });
    assert.equal(res.statusCode, 502);
  });

  test('never returns the raw claims to the caller', async () => {
    const res = await invoke({ prompt: 'hi' });
    assert.ok(!res.body.includes(SUB));
  });
});
