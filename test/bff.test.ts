import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, deriveActorId, deriveSessionId, extractScopes } from '../src/bff/handler.js';

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

/** Stand-in for a Cognito access token. Never parsed by the BFF, only forwarded. */
const ACCESS_TOKEN = 'header.payload.signature';

const invoke = (
  body: unknown,
  claims: Record<string, string> = {},
  headers: Record<string, string | undefined> = { Authorization: `Bearer ${ACCESS_TOKEN}` },
) =>
  handler({
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
    requestContext: { authorizer: { claims: { sub: SUB, scope: 'tools/weather:read', ...claims } } },
  });

beforeEach(() => { lastInput = null; nextError = null; });

describe('actor mapping', () => {
  test('is deterministic per subject and distinct across subjects', () => {
    assert.equal(deriveActorId(SUB), deriveActorId(SUB));
    assert.notEqual(deriveActorId(SUB), deriveActorId('another-subject'));
  });

  // Same `sub`, two different questions: which conversation, and which person. Long-term
  // memory is keyed on the second, so the day a per-conversation session id arrives, what
  // the agent has learned must not move with it.
  test('is a different value from the session id of the same subject', () => {
    assert.notEqual(deriveActorId(SUB), deriveSessionId(SUB));
  });

  test('never leaks the raw subject', () => {
    assert.ok(!deriveActorId(SUB).includes(SUB));
  });

  test('starts alphanumeric, as AgentCore requires of an actor id', () => {
    assert.match(deriveActorId(SUB), /^[a-zA-Z0-9][a-zA-Z0-9\-_/]*$/);
    assert.ok(deriveActorId(SUB).length <= 255);
  });

  test('the runtime receives the derived actor id, never a client-supplied one', async () => {
    await invoke({ prompt: 'Where should I go?', actorId: 'someone-else' });
    const payload = JSON.parse(new TextDecoder().decode(lastInput.payload));
    assert.equal(payload.actorId, deriveActorId(SUB));
  });

  // `runtimeUserId` is what makes AgentCore mint a workload access token for the container,
  // and AWS treats the value as an unverified opaque string — so the guarantee has to come
  // from us deriving it. Same value as the actor id: credentials and memories, one identity.
  test('the invocation names the user, derived from the token rather than the body', async () => {
    await invoke({ prompt: 'Flights to Lisbon?', actorId: 'someone-else' });
    assert.equal(lastInput.runtimeUserId, deriveActorId(SUB));
  });

  // A session holds one conversation; an actor holds everything the agent ever learned
  // about a person. The attempt has to be on record, not merely ineffective.
  test('an attempt to supply an actorId is recorded as blocked', async () => {
    const spans: any[] = [];
    const original = console.error;
    console.error = (line: string) => { try { spans.push(JSON.parse(line)); } catch { /* not a span */ } };
    try {
      await invoke({ prompt: 'Where should I go?', actorId: 'someone-else' });
    } finally {
      console.error = original;
    }

    const blocked = spans.find((s) => s.name === 'bff.client_supplied_identity');
    assert.ok(blocked, 'expected a blocked span for the supplied actorId');
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.attributes.suppliedActorId, true);
  });
});

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

describe('forwarding the access token', () => {
  /*
   * ADR-0004: the Gateway authorizes each tool call against the *caller's* scopes, so the
   * caller's own token has to reach the agent. The claims API Gateway parsed for us cannot
   * be turned back into a token the Gateway would accept, which is why the raw header is
   * read here at all.
   */
  test('the runtime receives the caller\'s access token', async () => {
    await invoke({ prompt: 'Weather in Lisbon?' });
    const payload = JSON.parse(new TextDecoder().decode(lastInput.payload));
    assert.equal(payload.accessToken, ACCESS_TOKEN);
  });

  test('a request with no bearer header is refused without invoking the runtime', async () => {
    const response = await invoke({ prompt: 'Weather in Lisbon?' }, {}, {});
    assert.equal(response.statusCode, 401);
    assert.equal(lastInput, null, 'the runtime must not be invoked without a token to pass on');
  });

  test('reads the header whatever its casing, as a proxy may rewrite it', async () => {
    await invoke({ prompt: 'Weather in Lisbon?' }, {}, { authorization: `bearer ${ACCESS_TOKEN}` });
    const payload = JSON.parse(new TextDecoder().decode(lastInput.payload));
    assert.equal(payload.accessToken, ACCESS_TOKEN);
  });

  // The BFF now handles a bearer token on a path that also writes spans. A token in a log
  // line is a token in CloudWatch.
  test('never writes the token into a span', async () => {
    const spans: any[] = [];
    const original = console.error;
    console.error = (line: string) => { try { spans.push(JSON.parse(line)); } catch { /* not a span */ } };
    try {
      await invoke({ prompt: 'Weather in Lisbon?', sessionId: 'someone-else' });
    } finally {
      console.error = original;
    }
    assert.ok(!JSON.stringify(spans).includes(ACCESS_TOKEN), 'a span quoted the access token');
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

/*
 * The browser harness in `web/` reads these responses cross-origin. API Gateway's preflight
 * answers the `OPTIONS` request but says nothing about what this function returns, so a
 * missing header here turns every error into an opaque "CORS error" in the console with the
 * status and the JSON body hidden — the failures worth debugging are exactly the ones that
 * would disappear. Hence: the header on every path, not just on the 200.
 */
describe('cross-origin responses', () => {
  test('the answer carries an allow-origin header', async () => {
    const res = await invoke({ prompt: 'hi' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['access-control-allow-origin'], '*');
  });

  test('every refusal and failure carries it too, or the browser hides the reason', async () => {
    const refusals = [
      await invoke({}),                                        // 400, no prompt
      await invoke('{ not json'),                              // 400, bad body
      await handler({ body: '{}', requestContext: { authorizer: { claims: {} } } }), // 401
      await invoke({ prompt: 'hi' }, {}, {}),                  // 401, no bearer
      await invoke({ prompt: 'hi' }, { scope: 'openid' }),     // 403, no tool scopes
    ];
    for (const res of refusals) {
      assert.ok(res.statusCode >= 400, `expected a refusal, got ${res.statusCode}`);
      assert.equal(res.headers['access-control-allow-origin'], '*');
    }

    nextError = new Error('runtime unavailable');
    const upstream = await invoke({ prompt: 'hi' });
    assert.equal(upstream.statusCode, 502);
    assert.equal(upstream.headers['access-control-allow-origin'], '*');
  });
});
