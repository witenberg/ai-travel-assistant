import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { McpClient, McpError, parseSseEnvelope } from '../src/mcp/client.js';

/**
 * The MCP client is hand-rolled, so it owes the same tests a dependency would have come
 * with. Every case here is a wire-level behaviour of Streamable HTTP that we would
 * otherwise be discovering against the deployed Gateway.
 */

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** A fake MCP server: answers by method, and records what it was asked. */
function fakeServer(
  answers: Record<string, (body: any) => { status?: number; contentType?: string; body?: string; headers?: Record<string, string> }>,
) {
  const requests: Recorded[] = [];

  const fetchImpl = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), headers: lowerCased(init.headers), body });

    const answer = answers[body.method]?.(body) ?? { status: 404, body: '' };
    const headers = new Headers({
      'content-type': answer.contentType ?? 'application/json',
      ...(answer.headers ?? {}),
    });

    return {
      ok: (answer.status ?? 200) < 400,
      status: answer.status ?? 200,
      headers,
      text: async () => answer.body ?? '',
    } as unknown as Response;
  }) as typeof fetch;

  return { requests, fetchImpl };
}

const lowerCased = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

const rpcOk = (id: unknown, result: unknown) => JSON.stringify({ jsonrpc: '2.0', id, result });

const initialize = (protocolVersion = '2025-06-18') => (body: any) => ({
  body: rpcOk(body.id, { protocolVersion, capabilities: {}, serverInfo: { name: 'gateway' } }),
  headers: { 'mcp-session-id': 'sess-42' },
});

const clientFor = (answers: Parameters<typeof fakeServer>[0], extra: Record<string, string> = {}) => {
  const server = fakeServer(answers);
  const client = new McpClient({
    url: 'https://gw.example.test/mcp',
    accessToken: 'the-token',
    extraHeaders: extra,
    fetchImpl: server.fetchImpl,
  });
  return { server, client };
};

describe('mcp client — handshake', () => {
  test('initializes before the first call and echoes the session id afterwards', async () => {
    const { server, client } = clientFor({
      initialize: initialize(),
      'notifications/initialized': () => ({ status: 202, body: '' }),
      'tools/list': (body) => ({ body: rpcOk(body.id, { tools: [] }) }),
    });

    await client.listTools();

    assert.deepEqual(server.requests.map((r) => r.body.method), [
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
    // The server assigns the session on initialize; every later request must carry it.
    assert.equal(server.requests[0]!.headers['mcp-session-id'], undefined);
    assert.equal(server.requests[2]!.headers['mcp-session-id'], 'sess-42');
  });

  // Two handshakes would leave two sessions where the server expects one, and the agent
  // does list and call in the same turn.
  test('handshakes once per client even under concurrent use', async () => {
    const { server, client } = clientFor({
      initialize: initialize(),
      'notifications/initialized': () => ({ status: 202, body: '' }),
      'tools/list': (body) => ({ body: rpcOk(body.id, { tools: [] }) }),
      'tools/call': (body) => ({ body: rpcOk(body.id, { content: [] }) }),
    });

    await Promise.all([client.listTools(), client.callTool('t', {}), client.listTools()]);

    assert.equal(server.requests.filter((r) => r.body.method === 'initialize').length, 1);
  });

  // A rejected handshake used to be memoised, so one bad container start failed every later
  // turn in that session — replayed with no I/O at all, which is why the span said 0 ms.
  test('retries a failed handshake instead of replaying the failure forever', async () => {
    let initializes = 0;
    const { server, client } = clientFor({
      initialize: (body: any) => {
        initializes++;
        return initializes === 1
          ? { status: 400, body: '{}' }
          : { body: rpcOk(body.id, { protocolVersion: '2025-03-26' }), headers: { 'mcp-session-id': 'sess-42' } };
      },
      'notifications/initialized': () => ({ status: 202, body: '' }),
      'tools/list': (body: any) => ({ body: rpcOk(body.id, { tools: [{ name: 't' }] }) }),
    });

    await assert.rejects(() => client.listTools(), /HTTP 400/);
    const tools = await client.listTools();

    assert.equal(initializes, 2, 'the second turn must try the handshake again');
    assert.equal(tools.length, 1);
    assert.ok(server.requests.some((r) => r.body.method === 'tools/list'));
  });

  // A client that keeps announcing a version the server did not agree to is a client that
  // breaks on the next service-side upgrade.
  test('adopts the protocol version the server answered with', async () => {
    const { server, client } = clientFor({
      initialize: initialize('2025-03-26'),
      'notifications/initialized': () => ({ status: 202, body: '' }),
      'tools/list': (body) => ({ body: rpcOk(body.id, { tools: [] }) }),
    });

    await client.listTools();
    assert.equal(server.requests.at(-1)!.headers['mcp-protocol-version'], '2025-03-26');
  });

  test('sends the bearer token and both accept types on every request', async () => {
    const { server, client } = clientFor(
      {
        initialize: initialize(),
        'notifications/initialized': () => ({ status: 202, body: '' }),
        'tools/list': (body) => ({ body: rpcOk(body.id, { tools: [] }) }),
      },
      { 'x-travel-session-id': 'session-abc' },
    );

    await client.listTools();
    for (const request of server.requests) {
      assert.equal(request.headers.authorization, 'Bearer the-token');
      assert.match(request.headers.accept!, /application\/json/);
      assert.match(request.headers.accept!, /text\/event-stream/);
      // Our own header, the one that carries the session across the Gateway.
      assert.equal(request.headers['x-travel-session-id'], 'session-abc');
    }
  });
});

describe('mcp client — tools', () => {
  const withTools = (pages: Array<{ tools: unknown[]; nextCursor?: string }>) => {
    let page = 0;
    return clientFor({
      initialize: initialize(),
      'notifications/initialized': () => ({ status: 202, body: '' }),
      'tools/list': (body) => ({ body: rpcOk(body.id, pages[page++]) }),
    });
  };

  test('reads every page of the tool list', async () => {
    const { client } = withTools([
      { tools: [{ name: 'a___one' }], nextCursor: 'next' },
      { tools: [{ name: 'a___two' }] },
    ]);

    assert.deepEqual((await client.listTools()).map((t) => t.name), ['a___one', 'a___two']);
  });

  test('a JSON-RPC error becomes an McpError, not a silent empty result', async () => {
    const { client } = clientFor({
      initialize: initialize(),
      'notifications/initialized': () => ({ status: 202, body: '' }),
      'tools/list': (body) =>
        ({ body: JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } }) }),
    });

    await assert.rejects(() => client.listTools(), (err: unknown) => err instanceof McpError && /nope/.test(String(err)));
  });

  test('carries isError through instead of throwing on a tool failure', async () => {
    const { client } = clientFor({
      initialize: initialize(),
      'notifications/initialized': () => ({ status: 202, body: '' }),
      'tools/call': (body) =>
        ({ body: rpcOk(body.id, { content: [{ type: 'text', text: 'denied' }], isError: true }) }),
    });

    const result = await client.callTool('x___y', { city: 'Lisbon' });
    assert.equal(result.isError, true);
    assert.equal(result.content[0]!.text, 'denied');
  });

  test('sends the tool name and arguments in the shape MCP defines', async () => {
    const { server, client } = clientFor({
      initialize: initialize(),
      'notifications/initialized': () => ({ status: 202, body: '' }),
      'tools/call': (body) => ({ body: rpcOk(body.id, { content: [] }) }),
    });

    await client.callTool('travel_tools___get_weather', { city: 'Lisbon' });
    const call = server.requests.at(-1)!.body;
    assert.equal(call.params.name, 'travel_tools___get_weather');
    assert.deepEqual(call.params.arguments, { city: 'Lisbon' });
  });
});

describe('mcp client — transport', () => {
  // A Streamable HTTP server chooses between a JSON body and a one-event SSE stream, and
  // the AWS docs do not say which the Gateway picks. Both have to work.
  test('reads a reply delivered as an SSE event', async () => {
    const { client } = clientFor({
      initialize: initialize(),
      'notifications/initialized': () => ({ status: 202, body: '' }),
      'tools/list': (body) => ({
        contentType: 'text/event-stream',
        body: `event: message\ndata: ${rpcOk(body.id, { tools: [{ name: 'a___one' }] })}\n\n`,
      }),
    });

    assert.equal((await client.listTools()).length, 1);
  });

  test('skips notifications and takes the message with an id', () => {
    const body = [
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
      '',
      'data: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}',
      '',
    ].join('\n');

    assert.deepEqual(parseSseEnvelope(body).result, { ok: true });
  });

  test('joins a multi-line data payload', () => {
    const body = 'data: {"jsonrpc":"2.0","id":1,\ndata: "result":{"ok":true}}\n\n';
    assert.deepEqual(parseSseEnvelope(body).result, { ok: true });
  });

  // Same rule as the Duffel client: an authorization failure's body can quote the
  // credential that was just sent.
  test('never echoes the body of a 401 or 403', async () => {
    for (const status of [401, 403]) {
      const { client } = clientFor({
        initialize: () => ({ status, body: 'token the-token is not valid for audience x' }),
      });

      await assert.rejects(
        () => client.listTools(),
        (err: unknown) => {
          const message = String(err);
          assert.ok(!message.includes('the-token'), `a ${status} leaked the token`);
          assert.match(message, new RegExp(`HTTP ${status}`));
          return true;
        },
      );
    }
  });

  test('reports a non-auth HTTP failure with enough detail to debug it', async () => {
    const { client } = clientFor({ initialize: () => ({ status: 500, body: 'gateway exploded' }) });
    await assert.rejects(() => client.listTools(), /HTTP 500.*gateway exploded/);
  });

  test('times out rather than hanging the turn', async () => {
    const client = new McpClient({
      url: 'https://gw.example.test/mcp',
      accessToken: 'the-token',
      timeoutMs: 10,
      fetchImpl: ((_url: any, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })) as typeof fetch,
    });

    await assert.rejects(() => client.listTools(), /timed out after 10ms/);
  });
});
