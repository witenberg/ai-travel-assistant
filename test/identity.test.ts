import { test, describe, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import {
  IDENTITY_WAT_HEADER,
  WORKLOAD_ACCESS_TOKEN_HEADER,
  currentWorkloadToken,
  runWithWorkloadToken,
  workloadTokenFromHeaders,
} from '../src/identity/workloadToken.js';
import {
  clearApiKeyCache,
  invalidateResourceApiKey,
  resourceApiKey,
} from '../src/identity/apiKey.js';
import { duffelGet, hasCredentials } from '../src/tools/duffel/client.js';
import { ToolError } from '../src/tools/types.js';
import { createServer } from '../src/server.js';
import type { AgentResult } from '../src/agent.js';

const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Captures everything written to stderr, which is where our spans and diagnostics go. */
function captureStderr() {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore: () => { console.error = original; } };
}

describe('workload access token delivery', () => {
  test('is read from the identity WAT header', () => {
    const found = workloadTokenFromHeaders({ [IDENTITY_WAT_HEADER]: 'wat-abc' });
    assert.deepEqual(found, { token: 'wat-abc', header: IDENTITY_WAT_HEADER });
  });

  test('falls back to the header name the devguide documents', () => {
    const found = workloadTokenFromHeaders({ [WORKLOAD_ACCESS_TOKEN_HEADER]: 'wat-def' });
    assert.deepEqual(found, { token: 'wat-def', header: WORKLOAD_ACCESS_TOKEN_HEADER });
  });

  test('the identity header wins when AgentCore sends both', () => {
    const found = workloadTokenFromHeaders({
      [WORKLOAD_ACCESS_TOKEN_HEADER]: 'old',
      [IDENTITY_WAT_HEADER]: 'new',
    });
    assert.equal(found?.token, 'new');
  });

  test('an absent or empty header is not a token', () => {
    assert.equal(workloadTokenFromHeaders({}), undefined);
    assert.equal(workloadTokenFromHeaders({ [IDENTITY_WAT_HEADER]: '   ' }), undefined);
  });

  test('the token is visible to code the turn calls, and to nothing outside it', async () => {
    assert.equal(currentWorkloadToken(), undefined);
    const seen = await runWithWorkloadToken('wat-scoped', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentWorkloadToken();
    });
    assert.equal(seen, 'wat-scoped');
    assert.equal(currentWorkloadToken(), undefined, 'the token must not outlive the turn');
  });

  test('two overlapping turns do not see each other tokens', async () => {
    const [a, b] = await Promise.all([
      runWithWorkloadToken('token-a', async () => {
        await new Promise((r) => setTimeout(r, 5));
        return currentWorkloadToken();
      }),
      runWithWorkloadToken('token-b', async () => currentWorkloadToken()),
    ]);
    assert.equal(a, 'token-a');
    assert.equal(b, 'token-b');
  });
});

describe('AgentCore Identity token vault', () => {
  beforeEach(() => clearApiKeyCache());

  test('exchanges the workload token for the provider API key', async () => {
    const calls: unknown[] = [];
    const result = await runWithWorkloadToken('wat-1', () =>
      resourceApiKey('duffel-api-key', {
        fetch: async (args) => { calls.push(args); return 'duffel_test_vault'; },
      }),
    );
    assert.deepEqual(result, { key: 'duffel_test_vault', source: 'identity' });
    assert.deepEqual(calls, [{ workloadToken: 'wat-1', providerName: 'duffel-api-key' }]);
  });

  test('the key is fetched once per container, not once per tool call', async () => {
    let fetches = 0;
    const fetch = async () => { fetches++; return 'k'; };
    await runWithWorkloadToken('wat-1', () => resourceApiKey('duffel-api-key', { fetch }));
    const second = await runWithWorkloadToken('wat-1', () => resourceApiKey('duffel-api-key', { fetch }));
    assert.equal(fetches, 1);
    assert.equal(second.source, 'cache', 'the source says where the key came from');
  });

  test('invalidating drops the cached key so the next call re-reads the vault', async () => {
    let fetches = 0;
    const fetch = async () => { fetches++; return `k${fetches}`; };
    await runWithWorkloadToken('wat-1', () => resourceApiKey('p', { fetch }));
    invalidateResourceApiKey('p');
    const after = await runWithWorkloadToken('wat-1', () => resourceApiKey('p', { fetch }));
    assert.equal(fetches, 2);
    assert.equal(after.key, 'k2');
  });

  test('without a workload token it says so, rather than failing as an auth error', async () => {
    await assert.rejects(
      () => resourceApiKey('duffel-api-key', { fetch: async () => 'never' }),
      (err: Error) => {
        assert.ok(err instanceof ToolError);
        assert.match(err.message, /workload access token/i);
        return true;
      },
    );
  });
});

describe('Duffel credential source', () => {
  beforeEach(() => {
    clearApiKeyCache();
    delete process.env.DUFFEL_ACCESS_TOKEN;
    process.env.DUFFEL_CREDENTIAL_PROVIDER = 'duffel-api-key';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.DUFFEL_CREDENTIAL_PROVIDER;
  });

  test('a provider name alone counts as configured — the key comes from the vault', () => {
    assert.equal(hasCredentials(), true);
  });

  test('sends the vault key as the bearer token, and logs neither it nor the workload token', async () => {
    // Prime the vault read with a stub, so the client's own call is a cache hit and this
    // test never reaches AWS. A unit test that silently calls GetResourceApiKey is not a
    // unit test — the first version of this one took 3 s and failed on real credentials.
    await runWithWorkloadToken('wat-secret', () =>
      resourceApiKey('duffel-api-key', { fetch: async () => 'duffel_test_from_vault' }),
    );

    const seen: Record<string, string>[] = [];
    globalThis.fetch = (async (_url: any, init: any = {}) => {
      seen.push(init.headers as Record<string, string>);
      return json({ data: [] });
    }) as typeof fetch;

    const stderr = captureStderr();
    try {
      await runWithWorkloadToken('wat-secret', () => duffelGet('/places/suggestions', { query: 'Lisbon' }));
    } finally {
      stderr.restore();
    }

    assert.equal(seen[0]!.authorization, 'Bearer duffel_test_from_vault');
    const logged = stderr.lines.join('\n');
    assert.match(logged, /"event":"duffel\.credential"/, 'the credential source is on record');
    assert.doesNotMatch(logged, /duffel_test_from_vault/, 'the key must never be logged');
    assert.doesNotMatch(logged, /wat-secret/, 'the workload access token must never be logged');
  });

  test('a rejected key is dropped from the cache, so the session is not poisoned', async () => {
    let fetches = 0;
    // Bypass the module cache check by driving the same path the client uses.
    const fetchKey = async () => { fetches++; return `key-${fetches}`; };
    await runWithWorkloadToken('wat-1', () => resourceApiKey('duffel-api-key', { fetch: fetchKey }));

    globalThis.fetch = (async () => json({ errors: [{ title: 'invalid' }] }, 401)) as typeof fetch;
    await assert.rejects(
      () => runWithWorkloadToken('wat-1', () => duffelGet('/places/suggestions')),
      /rejected the access token/,
    );

    const after = await runWithWorkloadToken('wat-1', () => resourceApiKey('duffel-api-key', { fetch: fetchKey }));
    assert.equal(fetches, 2, 'the 401 must invalidate the cached key');
    assert.equal(after.source, 'identity');
  });

  test('with neither source configured the message names both', async () => {
    delete process.env.DUFFEL_CREDENTIAL_PROVIDER;
    assert.equal(hasCredentials(), false);
    await assert.rejects(() => duffelGet('/x'), /DUFFEL_ACCESS_TOKEN.*DUFFEL_CREDENTIAL_PROVIDER/s);
  });
});

describe('POST /invocations makes the workload token available to tools', () => {
  let seen: string | undefined;
  const fakeAgent = (async (prompt: string): Promise<AgentResult> => {
    // Stands in for `search_flights`, three calls deeper than the request handler.
    seen = currentWorkloadToken();
    return { answer: `echo: ${prompt}`, messages: [], traceId: 't', toolCalls: [] };
  }) as any;

  const server = createServer({ runAgent: fakeAgent });
  let base = '';

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));

  const post = (headers: Record<string, string>) =>
    fetch(`${base}/invocations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ prompt: 'flights to Lisbon' }),
    });

  test('the header AgentCore injects reaches the turn', async () => {
    const res = await post({ [IDENTITY_WAT_HEADER]: 'wat-from-agentcore' });
    assert.equal(res.status, 200);
    assert.equal(seen, 'wat-from-agentcore');
  });

  test('an invocation without the header runs with no token rather than failing early', async () => {
    seen = 'stale';
    const res = await post({});
    assert.equal(res.status, 200, 'only the flights tool needs the token; the other three do not');
    assert.equal(seen, undefined);
  });
});
