import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createInterceptorHandler, SESSION_HEADER, type InterceptorInput } from '../src/gateway/interceptor.js';
import { createToolTargetHandler } from '../src/gateway/toolTarget.js';
import { gatewayToolName, stripTargetPrefix, TOOL_TARGET_NAME } from '../src/gateway/naming.js';
import { interpret } from '../src/tools/gatewayProvider.js';
import { GATEWAY_TOOLS, LOCAL_TOOLS, TOOLS, ToolError, type Tool } from '../src/tools/index.js';

/**
 * The Gateway half of Step 4. Everything here runs offline, because every one of these
 * behaviours would otherwise cost a deploy cycle to check — and the denial path in
 * particular is the one we least want to discover is wrong in the cloud.
 */

/** A JWT the way the interceptor sees one: already validated by the Gateway, so unsigned here. */
const tokenWithScopes = (scope: string, claims: Record<string, unknown> = {}): string => {
  const payload = Buffer.from(JSON.stringify({ scope, client_id: 'machine-client', ...claims }))
    .toString('base64url');
  return `header.${payload}.signature`;
};

const toolCall = (
  toolName: string,
  { token, sessionId = 'session-abc', id = 7 }: { token?: string; sessionId?: string; id?: number } = {},
): InterceptorInput => ({
  interceptorInputVersion: '1.0',
  mcp: {
    gatewayRequest: {
      path: '/mcp',
      httpMethod: 'POST',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        [SESSION_HEADER]: sessionId,
      },
      body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: { city: 'Lisbon' } } },
    },
  },
});

/** Reads the spans a handler wrote, the way the deployed log group would show them. */
async function spansFrom<T>(fn: () => Promise<T>): Promise<{ result: T; spans: any[] }> {
  const spans: any[] = [];
  const original = console.error;
  console.error = (line: string) => { try { spans.push(JSON.parse(line)); } catch { /* not a span */ } };
  try {
    return { result: await fn(), spans };
  } finally {
    console.error = original;
  }
}

/** The denial payload the interceptor puts on the wire, unwrapped. */
const denialOf = (output: any) => {
  const result = output.mcp.transformedGatewayResponse.body.result;
  return { isError: result.isError, payload: JSON.parse(result.content[0].text) };
};

describe('gateway tool naming', () => {
  test('strips the target prefix the Gateway adds', () => {
    assert.equal(stripTargetPrefix('travel_tools___get_weather'), 'get_weather');
  });

  // A tool name with no prefix must survive untouched: the Gateway is not the only
  // possible source of a name, and truncating an unprefixed one would break local tools.
  test('leaves an unprefixed name alone', () => {
    assert.equal(stripTargetPrefix('get_weather'), 'get_weather');
  });

  test('round-trips every tool the Gateway serves', () => {
    for (const tool of GATEWAY_TOOLS) {
      assert.equal(stripTargetPrefix(gatewayToolName(tool.name)), tool.name);
    }
  });
});

describe('tool registry split', () => {
  // The split is a deployment contract: a tool in neither list is a tool the deployed
  // agent cannot call at all, and nothing else would notice.
  test('every tool is either behind the Gateway or local, and none is both', () => {
    assert.equal(GATEWAY_TOOLS.length + LOCAL_TOOLS.length, TOOLS.length);
    for (const tool of GATEWAY_TOOLS) assert.ok(!LOCAL_TOOLS.includes(tool), `${tool.name} is in both lists`);
  });

  // ADR-0002 keeps the Duffel credential in the AgentCore Identity token vault, which the
  // Runtime's workload identity can reach and a Gateway Lambda target cannot.
  test('search_flights stays in the Runtime because of its outbound credential', () => {
    assert.deepEqual(LOCAL_TOOLS.map((t) => t.name), ['search_flights']);
  });
});

describe('gateway interceptor — pass-through', () => {
  const handler = createInterceptorHandler();

  // A REQUEST interceptor runs on every call, including the handshake. Refusing or
  // rewriting those would break the connection before any tool was ever asked for.
  for (const method of ['initialize', 'notifications/initialized', 'tools/list']) {
    test(`${method} passes through unchanged`, async () => {
      const body = { jsonrpc: '2.0', id: 1, method };
      const output = await handler({ mcp: { gatewayRequest: { body } } });
      assert.equal(output.interceptorOutputVersion, '1.0');
      assert.deepEqual(output.mcp.transformedGatewayRequest, { body });
      assert.equal(output.mcp.transformedGatewayResponse, undefined);
    });
  }

  // Deliberate: filtering the catalogue would hide the tool instead of refusing the call,
  // and the refusal is the trace the observability requirement is about.
  test('tools/list is not filtered by scope', async () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const output = await handler({
      mcp: { gatewayRequest: { headers: { Authorization: `Bearer ${tokenWithScopes('')}` }, body } },
    });
    assert.deepEqual(output.mcp.transformedGatewayRequest, { body });
  });
});

describe('gateway interceptor — authorization', () => {
  const handler = createInterceptorHandler();

  test('allows a call whose scope the token carries', async () => {
    const { result, spans } = await spansFrom(() =>
      handler(toolCall(gatewayToolName('get_weather'), { token: tokenWithScopes('tools/weather:read') })),
    );

    assert.ok(result.mcp.transformedGatewayRequest, 'the request should continue to the target');
    assert.equal(result.mcp.transformedGatewayResponse, undefined);

    const span = spans.find((s) => s.name === 'gateway.authorize');
    assert.ok(span, 'an allowed call still needs a span — otherwise silence proves nothing');
    assert.equal(span.status, 'ok');
    assert.equal(span.attributes.decision, 'allow');
  });

  test('refuses a call whose scope is missing, and answers instead of the target', async () => {
    const { result, spans } = await spansFrom(() =>
      handler(toolCall(gatewayToolName('get_photos'), { token: tokenWithScopes('tools/weather:read') })),
    );

    assert.equal(result.mcp.transformedGatewayRequest, undefined, 'the target must not be reached');
    const response = result.mcp.transformedGatewayResponse!;
    assert.equal(response.statusCode, 200);

    const { isError, payload } = denialOf(result);
    assert.equal(isError, true);
    assert.equal(payload.blocked, true);
    assert.match(payload.error, /photos:search/);

    // This is the span from the diagram: interceptor caught it, call was blocked.
    const span = spans.find((s) => s.name === 'gateway.authorize');
    assert.equal(span.status, 'blocked');
    assert.equal(span.attributes.decision, 'deny');
    assert.equal(span.attributes.requiredScope, 'photos:search');
    assert.deepEqual(span.attributes.grantedScopes, ['weather:read']);
  });

  // A refusal must arrive at the model as a failed tool_result, not as a broken protocol.
  // The JSON-RPC id is what ties the answer to the request the client is waiting on;
  // getting it wrong hangs the turn instead of ending it honestly.
  test('the refusal echoes the request id', async () => {
    const { result } = await spansFrom(() =>
      handler(toolCall(gatewayToolName('get_photos'), { token: tokenWithScopes(''), id: 42 })),
    );
    assert.equal((result.mcp.transformedGatewayResponse!.body as any).id, 42);
  });

  test('the denial carries the session id, so it joins the turn it came from', async () => {
    const { spans } = await spansFrom(() =>
      handler(toolCall(gatewayToolName('get_photos'), { token: tokenWithScopes(''), sessionId: 'session-xyz' })),
    );
    assert.equal(spans.find((s) => s.name === 'gateway.authorize').sessionId, 'session-xyz');
  });

  test('fails closed when the request carries no readable token', async () => {
    const { result, spans } = await spansFrom(() => handler(toolCall(gatewayToolName('get_weather'))));

    assert.equal(denialOf(result).payload.blocked, true);
    assert.equal(spans.find((s) => s.name === 'gateway.authorize').attributes.reason, 'no readable bearer token');
  });

  // A target added to the Gateway without a matching code change must not become an
  // unauthorized tool. "Unknown, therefore allowed" is how that happens.
  test('fails closed for a tool it does not know', async () => {
    const { result, spans } = await spansFrom(() =>
      handler(toolCall(`${TOOL_TARGET_NAME}___delete_everything`, { token: tokenWithScopes('tools/weather:read') })),
    );

    assert.equal(denialOf(result).payload.blocked, true);
    assert.equal(spans.find((s) => s.name === 'gateway.authorize').attributes.reason, 'unknown tool');
  });

  // The interceptor is the one component that holds a raw access token in memory. A token
  // in a log line is a token in CloudWatch, readable by anyone with log access.
  test('never writes the token to the log', async () => {
    const token = tokenWithScopes('tools/weather:read');
    const { spans } = await spansFrom(() =>
      handler(toolCall(gatewayToolName('get_photos'), { token })),
    );
    const serialised = JSON.stringify(spans);
    assert.ok(!serialised.includes(token), 'a span quoted the access token');
    assert.ok(!serialised.includes(token.split('.')[1]!), 'a span quoted the token payload');
  });

  // Header casing is the servers' choice, not ours: the docs show `Authorization`, and a
  // proxy is free to lower-case it.
  test('reads the Authorization header whatever its casing', async () => {
    const input = toolCall(gatewayToolName('get_weather'), { token: tokenWithScopes('tools/weather:read') });
    const headers = input.mcp!.gatewayRequest!.headers!;
    delete headers.Authorization;
    headers.authorization = `Bearer ${tokenWithScopes('tools/weather:read')}`;

    const { result } = await spansFrom(() => handler(input));
    assert.ok(result.mcp.transformedGatewayRequest, 'a lower-cased header should authorize the same call');
  });
});

describe('gateway lambda target', () => {
  const fakeTool: Tool<{ city: string }> = {
    name: 'get_weather',
    description: 'test double',
    requiredScope: 'weather:read',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
    async execute({ city }) {
      if (city === 'Atlantis') throw new ToolError('No place found named "Atlantis".');
      if (city === 'Boom') throw new Error('socket hang up');
      return { found: true, place: city };
    },
  };

  const handler = createToolTargetHandler([fakeTool]);
  const contextFor = (toolName: string) => ({
    clientContext: {
      custom: {
        bedrockAgentCoreToolName: toolName,
        bedrockAgentCoreMcpMessageId: 'msg-1',
        bedrockAgentCoreGatewayId: 'gw-1',
        bedrockAgentCoreTargetId: 'tgt-1',
      },
    },
    awsRequestId: 'req-1',
  });

  test('dispatches on the tool name after stripping the target prefix', async () => {
    const output = await handler({ city: 'Lisbon' }, contextFor(gatewayToolName('get_weather')));
    assert.deepEqual(output, { found: true, place: 'Lisbon' });
  });

  test('the event object is the tool input, with nothing to unwrap', async () => {
    const { spans } = await spansFrom(() =>
      handler({ city: 'Porto' }, contextFor(gatewayToolName('get_weather'))),
    );
    const span = spans.find((s) => s.name === 'gateway.tool.execute');
    assert.equal(span.status, 'ok');
    assert.equal(span.attributes.tool, 'get_weather');
    assert.equal(span.attributes.gatewayId, 'gw-1');
  });

  // The same convention `get_weather` already uses for a place that does not exist: a
  // failure the model can read and explain, rather than a protocol error whose wording
  // AWS chooses for us.
  test('returns a tool failure as data, and records it as an error span', async () => {
    const { result, spans } = await spansFrom(() =>
      handler({ city: 'Atlantis' }, contextFor(gatewayToolName('get_weather'))),
    );
    assert.match((result as any).error, /Atlantis/);
    assert.equal(spans.find((s) => s.name === 'gateway.tool.execute').status, 'error');
  });

  test('an unexpected error is still returned as data, not thrown at the Gateway', async () => {
    const { result } = await spansFrom(() =>
      handler({ city: 'Boom' }, contextFor(gatewayToolName('get_weather'))),
    );
    assert.match((result as any).error, /socket hang up/);
  });

  // Drift between the schema registered with the target and the code serving it is a
  // deploy problem. It must be loud, because a quiet default would answer wrongly.
  test('throws when the tool name is unknown or absent', async () => {
    await assert.rejects(
      () => handler({}, contextFor(gatewayToolName('get_flights'))),
      /no tool named "get_flights"/,
    );
    await assert.rejects(() => handler({}, { clientContext: { custom: {} } }), /bedrockAgentCoreToolName/);
  });
});

describe('reading a gateway tool result', () => {
  const textResult = (text: string, isError = false) => ({ content: [{ type: 'text', text }], isError });

  // Our targets return objects; the Gateway hands them over as a JSON string. Parsing it
  // back is what keeps the model's tool_result structured, as it was in process.
  test('parses a JSON payload back into an object', () => {
    assert.deepEqual(interpret(textResult('{"found":true,"place":"Lisbon"}')).output, {
      found: true,
      place: 'Lisbon',
    });
  });

  test('keeps non-JSON text as text rather than losing it', () => {
    assert.deepEqual(interpret(textResult('just words')).output, { text: 'just words' });
  });

  test('prefers structuredContent when the server sends it', () => {
    assert.deepEqual(
      interpret({ content: [{ type: 'text', text: 'ignored' }], structuredContent: { a: 1 } }).output,
      { a: 1 },
    );
  });

  // The marker is structural on purpose: reworded prose must not silently stop counting
  // as a security event.
  test('recognises an interceptor denial as blocked', () => {
    const outcome = interpret(textResult('{"error":"Missing scope \\"photos:search\\"","blocked":true}', true));
    assert.equal(outcome.blocked, true);
    assert.match(outcome.error!, /photos:search/);
  });

  test('a tool failure is an error but not a block', () => {
    const outcome = interpret(textResult('{"error":"upstream timed out"}', true));
    assert.equal(outcome.error, 'upstream timed out');
    assert.notEqual(outcome.blocked, true);
  });
});
