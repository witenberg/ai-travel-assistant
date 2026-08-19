import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createResponseInterceptorHandler,
  type ResponseInterceptorInput,
} from '../src/gateway/responseInterceptor.js';
import { SESSION_HEADER } from '../src/gateway/interceptor.js';
import { gatewayToolName } from '../src/gateway/naming.js';

const handler = createResponseInterceptorHandler();

const SESSION = 'a'.repeat(64);
const TOKEN = 'header.eyJzY29wZSI6InRvb2xzL3dlYXRoZXI6cmVhZCJ9.signature';

/** Captures the spans this interceptor writes, which go to stderr as JSON lines. */
function captureSpans<T>(fn: () => Promise<T>): Promise<{ result: T; spans: any[]; raw: string }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  return fn().then(
    (result) => {
      console.error = original;
      const spans = lines.map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
      return { result, spans, raw: lines.join('\n') };
    },
    (err) => { console.error = original; throw err; },
  );
}

const event = (
  requestBody: unknown,
  responseBody: unknown,
  opts: { statusCode?: number; headers?: Record<string, string> } = {},
): ResponseInterceptorInput => ({
  interceptorInputVersion: '1.0',
  mcp: {
    gatewayRequest: {
      path: '/mcp',
      httpMethod: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        [SESSION_HEADER]: SESSION,
        ...opts.headers,
      },
      body: requestBody as any,
    },
    gatewayResponse: {
      statusCode: opts.statusCode ?? 200,
      headers: {},
      body: responseBody as any,
    },
  },
});

const toolCall = (tool: string) => ({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: { name: gatewayToolName(tool), arguments: { place: 'Lisbon' } },
});

const toolResult = (payload: unknown, isError = false) => ({
  jsonrpc: '2.0',
  id: 4,
  result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError },
});

describe('gateway RESPONSE interceptor', () => {
  test('passes the response through as an identity transform, not as an empty object', async () => {
    // An empty `mcp` object is pass-through for HTTP targets only. On an MCP target it blanks
    // the body — the gateway answered `{}` to every call while this interceptor's own spans
    // said the calls had succeeded. Echoing what we were handed is the only safe contract.
    const response = toolResult({ forecast: [1, 2, 3] });
    const e = event(toolCall('get_weather'), response);
    e.mcp!.gatewayResponse!.headers = { 'Mcp-Session-Id': 'gateway-session-1' };
    const { result } = await captureSpans(() => handler(e));
    assert.deepEqual(result, {
      interceptorOutputVersion: '1.0',
      mcp: {
        transformedGatewayResponse: {
          statusCode: 200,
          headers: { 'Mcp-Session-Id': 'gateway-session-1' },
          body: response,
        },
      },
    });
  });

  test('echoes response headers, because initialize carries the MCP session id', async () => {
    // Dropping headers loses Mcp-Session-Id, and the *next* request then fails with
    // "HTTP 400: {}" — a symptom one call away from its cause, invisible to a client that
    // does no handshake.
    const init = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } };
    const e = event({ jsonrpc: '2.0', id: 1, method: 'initialize' }, init);
    e.mcp!.gatewayResponse!.headers = { 'Mcp-Session-Id': 'abc123' };
    const { result } = await captureSpans(() => handler(e));
    assert.deepEqual(result.mcp.transformedGatewayResponse!.headers, { 'Mcp-Session-Id': 'abc123' });
    assert.deepEqual(result.mcp.transformedGatewayResponse!.body, init);
  });

  test('a denial is echoed back verbatim — the refusal must reach the model intact', async () => {
    const denial = toolResult({ error: 'Missing scope "photos:search"...', blocked: true }, true);
    const { result } = await captureSpans(() => handler(event(toolCall('get_photos'), denial)));
    assert.deepEqual(result.mcp.transformedGatewayResponse!.body, denial);
  });

  test('records a successful tool call against the session the agent sent', async () => {
    const { spans } = await captureSpans(() =>
      handler(event(toolCall('get_weather'), toolResult({ forecast: [1, 2, 3] }))),
    );
    const span = spans.find((s) => s.name === 'gateway.tool.response');
    assert.ok(span, 'expected a gateway.tool.response span');
    assert.equal(span.status, 'ok');
    assert.equal(span.sessionId, SESSION, 'the outbound leg must land in the same Session');
    // The prefix AgentCore adds is stripped, so spans name tools the way the source does.
    assert.equal(span.attributes.tool, 'get_weather');
    assert.equal(span.attributes.statusCode, 200);
    assert.ok(span.attributes.bytes > 0, 'response size is the cheapest proxy for token cost');
  });

  test('a scope denial is blocked, not an error — it still reaches this interceptor', async () => {
    // The REQUEST interceptor short-circuited with this body; the docs say the RESPONSE
    // interceptor runs anyway. Reporting it as a failure would make every refusal an outage.
    const denial = toolResult({ error: 'Missing scope "photos:search"...', blocked: true }, true);
    const { spans } = await captureSpans(() => handler(event(toolCall('get_photos'), denial)));

    const span = spans.find((s) => s.name === 'gateway.tool.response');
    assert.equal(span.status, 'blocked');
    assert.equal(span.attributes.decision, 'deny');
    assert.equal(span.attributes.tool, 'get_photos');
  });

  test('a real tool failure is an error, and says why', async () => {
    const failure = toolResult({ error: 'HTTP 503 from api.open-meteo.com' }, true);
    const { spans } = await captureSpans(() => handler(event(toolCall('get_weather'), failure)));

    const span = spans.find((s) => s.name === 'gateway.tool.response');
    assert.equal(span.status, 'error');
    assert.match(span.attributes.reason, /isError|503/);
  });

  test('a JSON-RPC protocol error is an error too', async () => {
    const broken = { jsonrpc: '2.0', id: 4, error: { code: -32600, message: 'Unsupported protocol version' } };
    const { spans } = await captureSpans(() => handler(event(toolCall('get_weather'), broken)));

    const span = spans.find((s) => s.name === 'gateway.tool.response');
    assert.equal(span.status, 'error');
    assert.match(span.attributes.reason, /Unsupported protocol version/);
  });

  test('records the catalogue size on tools/list', async () => {
    const list = { jsonrpc: '2.0', id: 1, result: { tools: [{}, {}, {}] } };
    const { spans } = await captureSpans(() =>
      handler(event({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, list)),
    );
    const span = spans.find((s) => s.name === 'gateway.tools_list.response');
    assert.equal(span.attributes.tools, 3, 'a silently shrunken catalogue is the failure ADR-0004 forbids');
  });

  test('writes no span for protocol chatter, only the response-stage diagnostic', async () => {
    const { spans } = await captureSpans(() =>
      handler(event({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { jsonrpc: '2.0', id: 1, result: {} })),
    );
    assert.equal(spans.filter((s) => s.type === 'span').length, 0, 'initialize is not worth a span');
    // The diagnostic is written for every call, because this contract has surprised us twice.
    assert.equal(spans.filter((s) => s.event === 'response_stage').length, 1);
  });

  test('never logs the access token it can see', async () => {
    const { raw } = await captureSpans(() =>
      handler(event(toolCall('get_weather'), toolResult({ forecast: [] }))),
    );
    assert.doesNotMatch(raw, new RegExp(TOKEN.replace(/\./g, '\\.')), 'passRequestHeaders means a live token is in memory');
    assert.doesNotMatch(raw, /Bearer/);
  });

  test('a session id the agent did not send is reported as unknown, not invented', async () => {
    const e = event(toolCall('get_weather'), toolResult({}));
    delete (e.mcp!.gatewayRequest!.headers as Record<string, unknown>)[SESSION_HEADER];
    const { spans } = await captureSpans(() => handler(e));
    assert.equal(spans.find((s) => s.name === 'gateway.tool.response').sessionId, 'unknown');
  });

  test('a malformed event costs a span, never the answer', async () => {
    // Telemetry on the path of every tool result must not be able to break one.
    for (const bad of [{}, { mcp: {} }, { mcp: { gatewayRequest: { body: null } } }] as any[]) {
      const { result } = await captureSpans(() => handler(bad));
      // No response in the event means there was none to preserve, so an empty `mcp` is all
      // that is left — and in that case there is nothing it could blank.
      assert.deepEqual(result, { interceptorOutputVersion: '1.0', mcp: {} });
    }
  });
});
