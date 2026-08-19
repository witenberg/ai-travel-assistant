import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { authorize } from '../src/guard.js';
import { getPhotos } from '../src/tools/getPhotos.js';
import { Trace, type SpanRecord } from '../src/observability/trace.js';

const collectingTrace = () => {
  const spans: SpanRecord[] = [];
  return { trace: new Trace('test-session', (s) => spans.push(s)), spans };
};

describe('scope interceptor (guard)', () => {
  test('allows a call when the scope is granted', () => {
    const { trace, spans } = collectingTrace();
    assert.equal(authorize(getPhotos, ['photos:search'], trace).allowed, true);
    assert.equal(spans.length, 0, 'an allowed call should not emit a block span');
  });

  test('blocks a call without the scope and leaves a trace', () => {
    const { trace, spans } = collectingTrace();
    const decision = authorize(getPhotos, ['weather:read'], trace);

    assert.equal(decision.allowed, false);
    assert.match(decision.reason!, /photos:search/);

    // This is the trace from the diagram: interceptor caught it, call was blocked.
    assert.equal(spans.length, 1);
    assert.equal(spans[0]!.status, 'blocked');
    assert.equal(spans[0]!.attributes.tool, 'get_photos');
    assert.equal(spans[0]!.attributes.decision, 'deny');
  });
});

describe('Trace', () => {
  test('spans are written to stderr, not stdout', async () => {
    // AgentCore Runtime delivers stderr to CloudWatch and drops stdout. A span
    // emitted on stdout is invisible in production, which is how this was found.
    const written: { out: string[]; err: string[] } = { out: [], err: [] };
    const realLog = console.log;
    const realError = console.error;
    console.log = (m: any) => { written.out.push(String(m)); };
    console.error = (m: any) => { written.err.push(String(m)); };
    try {
      await new Trace('stderr-check').span('step', { k: 1 }, async () => 'ok');
    } finally {
      console.log = realLog;
      console.error = realError;
    }
    assert.equal(written.out.length, 0, 'nothing may go to stdout — it is dropped in AgentCore');
    assert.equal(written.err.length, 1);
    assert.equal(JSON.parse(written.err[0]!).name, 'step');
  });

  test('an error span is logged and the exception propagates', async () => {
    const { trace, spans } = collectingTrace();
    await assert.rejects(() => trace.span('step', {}, async () => { throw new Error('boom'); }));
    assert.equal(spans[0]!.status, 'error');
    assert.equal(spans[0]!.attributes.error, 'boom');
  });
});
