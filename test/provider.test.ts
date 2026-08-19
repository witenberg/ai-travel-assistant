import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CompositeToolProvider,
  LocalToolProvider,
  type ToolOutcome,
  type ToolProvider,
} from '../src/tools/provider.js';
import { GatewayToolProvider } from '../src/tools/gatewayProvider.js';
import { McpClient } from '../src/mcp/client.js';
import { buildToolProvider } from '../src/server.js';
import { Trace } from '../src/observability/trace.js';
import { ToolError, type Tool } from '../src/tools/index.js';

/**
 * The seam that decides where a tool runs and who authorized it. These tests are the
 * reason the seam exists: the difference between "refused" and "broken", and the rule that
 * a Gateway refusal must never fall through to local execution, are both invisible in a
 * green deploy.
 */

const trace = new Trace('session-test', () => {});

const toolNamed = (name: string, scope: string, behaviour: 'ok' | 'toolError' | 'throw' = 'ok'): Tool => ({
  name,
  description: `test double for ${name}`,
  requiredScope: scope,
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    if (behaviour === 'toolError') throw new ToolError('upstream said no');
    if (behaviour === 'throw') throw new Error('kaboom');
    return { ran: name };
  },
});

describe('local tool provider', () => {
  test('runs a tool whose scope is granted', async () => {
    const provider = new LocalToolProvider([toolNamed('t', 'weather:read')], ['weather:read']);
    assert.deepEqual((await provider.call('t', {}, trace)).output, { ran: 't' });
  });

  test('a missing scope is a block, not an error', async () => {
    const provider = new LocalToolProvider([toolNamed('t', 'photos:search')], ['weather:read']);
    const outcome = await provider.call('t', {}, trace);
    assert.equal(outcome.blocked, true);
    assert.match(outcome.error!, /photos:search/);
    assert.equal(outcome.output, undefined);
  });

  // A failing tool is not a security event, and conflating the two would put every
  // upstream timeout in the same bucket as a denied scope.
  test('a tool failure is an error but not a block', async () => {
    const provider = new LocalToolProvider([toolNamed('t', 'weather:read', 'toolError')], ['weather:read']);
    const outcome = await provider.call('t', {}, trace);
    assert.equal(outcome.error, 'upstream said no');
    assert.notEqual(outcome.blocked, true);
  });

  test('an unexpected throw is contained instead of ending the turn', async () => {
    const provider = new LocalToolProvider([toolNamed('t', 'weather:read', 'throw')], ['weather:read']);
    assert.match((await provider.call('t', {}, trace)).error!, /kaboom/);
  });

  test('advertises only the tools it was given', async () => {
    const provider = new LocalToolProvider([toolNamed('t', 'weather:read')], []);
    assert.deepEqual((await provider.list()).map((s) => s.name), ['t']);
  });

  test('an unknown tool is refused, not executed', async () => {
    const provider = new LocalToolProvider([toolNamed('t', 'weather:read')], ['weather:read']);
    assert.equal((await provider.call('other', {}, trace)).blocked, true);
  });
});

describe('composite tool provider', () => {
  const stub = (names: string[], marker: string): ToolProvider & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      async list() {
        return names.map((name) => ({ name, description: marker, inputSchema: { type: 'object' } }));
      },
      async call(name: string): Promise<ToolOutcome> {
        calls.push(name);
        return { output: { from: marker } };
      },
    };
  };

  test('merges the catalogues in order', async () => {
    const composite = new CompositeToolProvider([stub(['a', 'b'], 'first'), stub(['c'], 'second')]);
    assert.deepEqual((await composite.list()).map((s) => s.name), ['a', 'b', 'c']);
  });

  test('routes each call to the provider that advertised it', async () => {
    const first = stub(['a'], 'first');
    const second = stub(['b'], 'second');
    const composite = new CompositeToolProvider([first, second]);
    await composite.list();

    assert.deepEqual((await composite.call('b', {}, trace)).output, { from: 'second' });
    assert.deepEqual(first.calls, [], 'the wrong provider was consulted');
    assert.deepEqual(second.calls, ['b']);
  });

  /*
   * The property this whole class exists for. If a name resolved by trying providers in
   * turn, a tool the Gateway refused would then be executed locally — resilience that
   * quietly undoes the authorization we deployed the Gateway to perform.
   */
  test('never retries a call against another provider', async () => {
    const gateway: ToolProvider = { async list() { return [{ name: 'a', description: '', inputSchema: {} }]; },
      async call() { return { error: 'Missing scope "weather:read".', blocked: true }; } };
    const local = stub(['a'], 'local');

    const composite = new CompositeToolProvider([gateway, local]);
    await composite.list();
    const outcome = await composite.call('a', {}, trace);

    assert.equal(outcome.blocked, true);
    assert.deepEqual(local.calls, [], 'a refused tool was executed locally');
  });

  test('a duplicate name belongs to the first provider that claimed it', async () => {
    const composite = new CompositeToolProvider([stub(['a'], 'first'), stub(['a'], 'second')]);
    assert.deepEqual((await composite.list()).map((s) => s.name), ['a']);
    assert.deepEqual((await composite.call('a', {}, trace)).output, { from: 'first' });
  });

  // The routing table is built by `list()`. A caller that skips it deserves an answer, not
  // a spurious "unknown tool".
  test('builds its routing table on demand when call comes first', async () => {
    const composite = new CompositeToolProvider([stub(['a'], 'first')]);
    assert.deepEqual((await composite.call('a', {}, trace)).output, { from: 'first' });
  });
});

describe('gateway tool provider', () => {
  const gatewayClient = (tools: Array<{ name: string; description?: string; inputSchema?: any }>) => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const client = {
      async listTools() { return tools; },
      async callTool(name: string, args: unknown) {
        calls.push({ name, args });
        return { content: [{ type: 'text', text: '{"found":true}' }], isError: false };
      },
    } as unknown as McpClient;
    return { client, calls };
  };

  test('advertises tools under their unprefixed names', async () => {
    const { client } = gatewayClient([{ name: 'travel_tools___get_weather', description: 'w' }]);
    assert.deepEqual((await new GatewayToolProvider(client).list()).map((s) => s.name), ['get_weather']);
  });

  test('calls the Gateway under the prefixed name it advertised', async () => {
    const { client, calls } = gatewayClient([{ name: 'travel_tools___get_weather' }]);
    const provider = new GatewayToolProvider(client);
    await provider.call('get_weather', { city: 'Lisbon' }, trace);
    assert.deepEqual(calls, [{ name: 'travel_tools___get_weather', args: { city: 'Lisbon' } }]);
  });

  test('lists once per cache, however many turns ask', async () => {
    let lists = 0;
    const client = {
      async listTools() { lists++; return [{ name: 'travel_tools___get_weather' }]; },
      async callTool() { return { content: [], isError: false }; },
    } as unknown as McpClient;

    const cache = {};
    await new GatewayToolProvider(client, cache).list();
    await new GatewayToolProvider(client, cache).list();
    assert.equal(lists, 1);
  });

  test('a transport failure comes back as a tool error, not a thrown turn', async () => {
    const client = {
      async listTools() { return [{ name: 'travel_tools___get_weather' }]; },
      async callTool() { throw new (await import('../src/mcp/client.js')).McpError('HTTP 503'); },
    } as unknown as McpClient;

    const outcome = await new GatewayToolProvider(client).call('get_weather', {}, trace);
    assert.match(outcome.error!, /Gateway call failed: HTTP 503/);
    assert.notEqual(outcome.blocked, true);
  });
});

describe('choosing where tools come from', () => {
  const localScopes = ['weather:read', 'flights:read'];

  test('with no gateway configured, everything runs in process', async () => {
    const provider = buildToolProvider({ scopes: localScopes, sessionId: 's', gatewayUrl: undefined });
    const names = (await provider.list()).map((s) => s.name);
    assert.ok(names.includes('get_weather'));
    assert.ok(names.includes('search_flights'));
  });

  /*
   * The important case. A Gateway configured but unreachable for lack of a token must fail
   * the turn: falling back to in-process execution would look like graceful degradation
   * and would in fact be a bypass of the authorization we just moved to the Gateway.
   */
  test('a configured gateway with no access token fails closed', () => {
    assert.throws(
      () => buildToolProvider({ scopes: localScopes, sessionId: 's', gatewayUrl: 'https://gw.test/mcp' }),
      /carried no access token/,
    );
  });

  test('with both, tools come from a composite of the Gateway and the local half', () => {
    const provider = buildToolProvider({
      scopes: localScopes,
      sessionId: 's',
      accessToken: 'token',
      gatewayUrl: 'https://gw.invalid/mcp',
    });
    assert.ok(provider instanceof CompositeToolProvider);
  });

  /*
   * An unreachable Gateway fails the turn. It would be easy to let the composite skip a
   * provider that could not answer and carry on with the rest, and that is the wrong
   * trade: the model would then be told only `search_flights` exists and would explain,
   * confidently and wrongly, that it cannot check the weather. A user cannot tell that
   * apart from a real limitation, while a failed turn is plainly a failure.
   *
   * The rule this follows: memory is an enhancement and degrades quietly (ADR-0003), tools
   * are the product and fail loudly.
   */
  test('an unreachable Gateway fails the turn rather than shrinking the toolset', async () => {
    const provider = buildToolProvider({
      scopes: localScopes,
      sessionId: 's',
      accessToken: 'token',
      gatewayUrl: 'https://gw.invalid/mcp',
    });
    await assert.rejects(() => provider.list());
  });
});
