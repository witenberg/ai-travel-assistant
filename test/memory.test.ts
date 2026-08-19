import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '@aws-sdk/client-bedrock-runtime';
import {
  AgentCoreMemoryStore,
  NullMemoryStore,
  alternating,
  memoryStoreFromEnv,
  preferenceText,
  MAX_HISTORY_TURNS,
  type MemoryRef,
} from '../src/memory/store.js';
import { runAgent } from '../src/agent.js';
import { buildSystemPrompt } from '../src/prompt.js';

const MEMORY_ID = 'travel_assistant_memory-Np64SnHkoA';
const REF: MemoryRef = { actorId: 'u-abc123', sessionId: 'sess-000000000000000000000000000000001' };

/** Records every command the store sent, and replays a scripted response. */
let sent: any[] = [];
let responses: Record<string, unknown> = {};

const fakeClient = {
  async send(command: any) {
    sent.push(command);
    return responses[command.constructor.name] ?? {};
  },
} as any;

const store = new AgentCoreMemoryStore(MEMORY_ID, fakeClient);

const event = (seconds: number, ...pairs: [string, string][]) => ({
  eventTimestamp: new Date(Date.UTC(2026, 7, 19, 12, 0, seconds)),
  payload: pairs.map(([role, text]) => ({ conversational: { role, content: { text } } })),
});

beforeEach(() => { sent = []; responses = {}; });

describe('short-term memory: reading a session back', () => {
  test('maps stored events onto Converse messages', async () => {
    responses.ListEventsCommand = { events: [event(1, ['USER', 'Weather in Lisbon?'], ['ASSISTANT', 'Sunny.'])] };

    const history = await store.loadHistory(REF);

    assert.deepEqual(history, [
      { role: 'user', content: [{ text: 'Weather in Lisbon?' }] },
      { role: 'assistant', content: [{ text: 'Sunny.' }] },
    ]);
  });

  test('scopes the read to one actor and one session', async () => {
    responses.ListEventsCommand = { events: [] };
    await store.loadHistory(REF);

    assert.equal(sent[0].input.memoryId, MEMORY_ID);
    assert.equal(sent[0].input.actorId, REF.actorId);
    assert.equal(sent[0].input.sessionId, REF.sessionId);
  });

  // An uncapped history is billed as input tokens on every later turn, so the cost of a
  // conversation would grow with its length — the one runaway a per-request throttle
  // cannot see. The cap is a budget control and belongs in a test, not in a comment.
  test('asks for a bounded number of turns', async () => {
    responses.ListEventsCommand = { events: [] };
    await store.loadHistory(REF);

    assert.equal(sent[0].input.maxResults, MAX_HISTORY_TURNS);
  });

  // A reversed history is worse than no history: the model reads every answer before
  // its question. The API does not promise an order, so we impose one.
  test('orders turns oldest first regardless of the order returned', async () => {
    responses.ListEventsCommand = {
      events: [
        event(20, ['USER', 'And photos?'], ['ASSISTANT', 'Here they are.']),
        event(10, ['USER', 'Weather in Lisbon?'], ['ASSISTANT', 'Sunny.']),
      ],
    };

    const history = await store.loadHistory(REF);

    assert.deepEqual(history.map((m) => m.content?.[0]?.text), [
      'Weather in Lisbon?', 'Sunny.', 'And photos?', 'Here they are.',
    ]);
  });

  test('ignores payload entries that carry no conversational text', async () => {
    responses.ListEventsCommand = {
      events: [{
        eventTimestamp: new Date(),
        payload: [
          { blob: { anything: true } },
          { conversational: { role: 'USER', content: { text: 'Hello' } } },
          { conversational: { role: 'ASSISTANT', content: { text: '  ' } } },
        ],
      }],
    };

    // 'Hello' alone would leave a trailing user message, which `alternating` drops.
    assert.deepEqual(await store.loadHistory(REF), []);
  });
});

describe('history is kept valid for Converse', () => {
  const user = (text: string): Message => ({ role: 'user', content: [{ text }] });
  const assistant = (text: string): Message => ({ role: 'assistant', content: [{ text }] });

  test('a well-formed conversation passes through untouched', () => {
    const messages = [user('a'), assistant('b'), user('c'), assistant('d')];
    assert.deepEqual(alternating(messages), messages);
  });

  test('drops a message that breaks the alternation instead of forwarding it', () => {
    assert.deepEqual(alternating([user('a'), user('duplicate'), assistant('b')]),
      [user('a'), assistant('b')]);
  });

  test('never starts with an assistant message', () => {
    assert.deepEqual(alternating([assistant('orphan'), user('a'), assistant('b')]),
      [user('a'), assistant('b')]);
  });

  // A turn whose save half-succeeded leaves a question with no answer. Replayed as-is it
  // would sit next to the incoming user message and Converse would reject the whole turn
  // — permanently, for every later turn in that session.
  test('drops a trailing user message, which would collide with the incoming one', () => {
    assert.deepEqual(alternating([user('a'), assistant('b'), user('unanswered')]),
      [user('a'), assistant('b')]);
  });
});

describe('long-term memory: preferences', () => {
  test('searches the namespace belonging to the actor', async () => {
    responses.RetrieveMemoryRecordsCommand = { memoryRecordSummaries: [] };
    await store.loadPreferences(REF, 'Where should I go in October?');

    assert.equal(sent[0].input.namespace, `/preferences/${REF.actorId}`);
    assert.equal(sent[0].input.searchCriteria.searchQuery, 'Where should I go in October?');
  });

  test('returns the record texts', async () => {
    responses.RetrieveMemoryRecordsCommand = {
      memoryRecordSummaries: [
        { content: { text: 'Prefers warm coastal destinations' } },
        { content: { text: 'Travels with two children' } },
        { content: {} },
      ],
    };

    assert.deepEqual(await store.loadPreferences(REF, 'anything'),
      ['Prefers warm coastal destinations', 'Travels with two children']);
  });

  // Shape taken from a record the deployed strategy actually produced, not from the docs.
  test('unwraps the serialised record the USER_PREFERENCE strategy stores', () => {
    const stored = JSON.stringify({
      context: 'The user explicitly mentioned they are thinking about Lisbon.',
      preference: 'Interested in visiting Lisbon, Portugal for a short holiday',
      categories: ['travel', 'vacation', 'destinations'],
    });

    // `context` restates the turn and `categories` are retrieval metadata; passing the
    // whole blob would spend three fields of tokens on one field of meaning, every turn.
    assert.equal(preferenceText(stored), 'Interested in visiting Lisbon, Portugal for a short holiday');
  });

  // The record shape is AWS's to change. A prompt line that reads oddly beats a
  // preference silently dropped.
  test('falls back to the raw text when the record is not the expected shape', () => {
    assert.equal(preferenceText('Prefers mountains'), 'Prefers mountains');
    assert.equal(preferenceText('{"categories":["travel"]}'), '{"categories":["travel"]}');
    assert.equal(preferenceText('   '), undefined);
    assert.equal(preferenceText(undefined), undefined);
  });
});

describe('writing a turn', () => {
  // One event, not two. A question stored without its answer replays as a dangling user
  // turn and shows the extraction strategy half a conversation.
  test('stores question and answer as a single event', async () => {
    await store.saveTurn(REF, { user: 'Weather in Lisbon?', assistant: 'Sunny.' });

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].input.payload, [
      { conversational: { role: 'USER', content: { text: 'Weather in Lisbon?' } } },
      { conversational: { role: 'ASSISTANT', content: { text: 'Sunny.' } } },
    ]);
    assert.equal(sent[0].input.actorId, REF.actorId);
    assert.equal(sent[0].input.sessionId, REF.sessionId);
  });
});

describe('choosing a store', () => {
  test('without a memory resource the agent still runs, remembering nothing', async () => {
    const chosen = memoryStoreFromEnv(undefined);
    assert.ok(chosen instanceof NullMemoryStore);
    assert.deepEqual(await chosen.loadHistory(REF), []);
    assert.deepEqual(await chosen.loadPreferences(REF, 'x'), []);
  });

  test('with one, the real store is used', () => {
    assert.ok(memoryStoreFromEnv(MEMORY_ID) instanceof AgentCoreMemoryStore);
  });
});

describe('preferences reach the model', () => {
  test('are rendered into the system prompt', () => {
    const prompt = buildSystemPrompt(new Date(), ['Prefers warm coastal destinations']);
    assert.match(prompt, /Prefers warm coastal destinations/);
  });

  // Extracted by a model from earlier turns, not stated by the user in this one. Handed
  // over unlabelled they would be indistinguishable from something just said.
  test('are labelled as possibly stale rather than presented as fact', () => {
    const prompt = buildSystemPrompt(new Date(), ['Prefers warm coastal destinations']);
    assert.match(prompt, /may be out of date/);
    assert.match(prompt, /the current message wins/);
  });

  test('an empty set adds nothing to the prompt', () => {
    assert.equal(buildSystemPrompt(new Date(), []), buildSystemPrompt(new Date()));
  });
});

describe('the agent uses the store', () => {
  /** A Bedrock client that answers once, with no tool use, and records what it was sent. */
  const converse = (capture: { input?: any } = {}) => ({
    async send(command: any) {
      // Snapshot, not a reference: the agent keeps pushing onto the same `messages`
      // array after the call returns, so a live reference would show a later state.
      capture.input = { ...command.input, messages: [...command.input.messages] };
      return { output: { message: { role: 'assistant', content: [{ text: 'Sunny.' }] } }, stopReason: 'end_turn' };
    },
  }) as any;

  test('prepends stored history and persists the finished turn', async () => {
    const saved: any[] = [];
    const memory = {
      async loadHistory() { return [
        { role: 'user', content: [{ text: 'Weather in Lisbon?' }] },
        { role: 'assistant', content: [{ text: 'Sunny.' }] },
      ] as Message[]; },
      async loadPreferences() { return ['Prefers warm coastal destinations']; },
      async saveTurn(ref: MemoryRef, turn: unknown) { saved.push({ ref, turn }); },
    };
    const capture: { input?: any } = {};

    await runAgent('And what about photos there?', {
      sessionId: REF.sessionId, actorId: REF.actorId, memory, client: converse(capture),
    });

    assert.equal(capture.input.messages.length, 3);
    assert.equal(capture.input.messages[0].content[0].text, 'Weather in Lisbon?');
    assert.match(capture.input.system[0].text, /Prefers warm coastal destinations/);
    assert.deepEqual(saved, [{
      ref: REF,
      turn: { user: 'And what about photos there?', assistant: 'Sunny.' },
    }]);
  });

  // Memory is an enhancement. An agent that answers without recall is degraded; an agent
  // that refuses to answer because recall timed out is broken.
  test('answers anyway when the store is unreachable', async () => {
    const broken = {
      async loadHistory(): Promise<Message[]> { throw new Error('memory unreachable'); },
      async loadPreferences(): Promise<string[]> { throw new Error('memory unreachable'); },
      async saveTurn(): Promise<void> { throw new Error('memory unreachable'); },
    };

    const result = await runAgent('Weather in Lisbon?', {
      sessionId: REF.sessionId, actorId: REF.actorId, memory: broken, client: converse(),
    });

    assert.equal(result.answer, 'Sunny.');
  });

  test('an explicitly passed history bypasses the store', async () => {
    let consulted = false;
    const memory = {
      async loadHistory() { consulted = true; return []; },
      async loadPreferences() { return []; },
      async saveTurn() {},
    };

    await runAgent('Hello', {
      sessionId: REF.sessionId, memory, history: [], client: converse(),
    });

    assert.equal(consulted, false);
  });
});
