import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListEventsCommand,
  RetrieveMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { Message } from '@aws-sdk/client-bedrock-runtime';

/**
 * AgentCore Memory, behind a seam.
 *
 * Two implementations for the same reason `guard.ts` mirrors the Gateway interceptors:
 * the agent must run locally and under test with no AWS account. `NullMemoryStore` is
 * not a stub for tests only — it is what `npm run dev` uses, so a local run behaves
 * like the deployed one minus recall, rather than crashing on a missing resource.
 *
 * Actor and session are deliberately separate ideas:
 *   actorId   - the person. Long-term records live in a namespace keyed on it, so what
 *               the agent learns outlives any single conversation.
 *   sessionId - one conversation. Short-term events are scoped to it.
 * Today both derive from the same Cognito `sub`, because there is no per-conversation
 * concept yet. Keeping them apart now means adding one later touches only the BFF.
 */

export interface MemoryRef {
  actorId: string;
  sessionId: string;
}

export interface Turn {
  user: string;
  assistant: string;
}

export interface MemoryStore {
  /** Previous turns of this conversation, oldest first, ready to prepend to Converse. */
  loadHistory(ref: MemoryRef): Promise<Message[]>;
  /** Long-term facts about this actor that are relevant to `query`. */
  loadPreferences(ref: MemoryRef, query: string): Promise<string[]>;
  /** Persist one completed turn. */
  saveTurn(ref: MemoryRef, turn: Turn): Promise<void>;
}

/**
 * How many past turns are replayed into the model.
 *
 * This is a budget control, not a UX preference. Every replayed turn is billed as input
 * tokens on every subsequent turn, so an uncapped history makes conversation cost grow
 * quadratically — the one shape of runaway spend that a per-request throttle cannot see.
 */
export const MAX_HISTORY_TURNS = 10;

/** Long-term records injected into the prompt. Same reasoning: recall is not free. */
export const MAX_PREFERENCES = 5;

/** Namespace template AgentCore fills per actor; must match the CDK strategy. */
export const PREFERENCE_NAMESPACE = (actorId: string) => `/preferences/${actorId}`;

export class NullMemoryStore implements MemoryStore {
  async loadHistory(_ref: MemoryRef): Promise<Message[]> { return []; }
  async loadPreferences(_ref: MemoryRef, _query: string): Promise<string[]> { return []; }
  async saveTurn(_ref: MemoryRef, _turn: Turn): Promise<void> {
    /* nothing to remember without a Memory resource */
  }
}

type Sender = Pick<BedrockAgentCoreClient, 'send'>;

export class AgentCoreMemoryStore implements MemoryStore {
  constructor(
    private readonly memoryId: string,
    private readonly client: Sender = new BedrockAgentCoreClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
    }),
  ) {}

  async loadHistory(ref: MemoryRef): Promise<Message[]> {
    const out = await this.client.send(new ListEventsCommand({
      memoryId: this.memoryId,
      actorId: ref.actorId,
      sessionId: ref.sessionId,
      includePayloads: true,
      // Each turn is stored as one event carrying both messages, so turns map 1:1 here.
      maxResults: MAX_HISTORY_TURNS,
    }));

    // The API does not promise an order, and a reversed history is worse than none —
    // the model would read the answers before the questions. Sort explicitly.
    const events = [...(out.events ?? [])].sort(
      (a, b) => (a.eventTimestamp?.getTime() ?? 0) - (b.eventTimestamp?.getTime() ?? 0),
    );

    const messages: Message[] = [];
    for (const event of events) {
      for (const entry of event.payload ?? []) {
        const text = entry.conversational?.content?.text?.trim();
        const role = entry.conversational?.role;
        if (!text || (role !== 'USER' && role !== 'ASSISTANT')) continue;
        messages.push({ role: role === 'USER' ? 'user' : 'assistant', content: [{ text }] });
      }
    }

    return alternating(messages);
  }

  async loadPreferences(ref: MemoryRef, query: string): Promise<string[]> {
    const out = await this.client.send(new RetrieveMemoryRecordsCommand({
      memoryId: this.memoryId,
      namespace: PREFERENCE_NAMESPACE(ref.actorId),
      searchCriteria: { searchQuery: query, topK: MAX_PREFERENCES },
      maxResults: MAX_PREFERENCES,
    }));

    return (out.memoryRecordSummaries ?? [])
      .map((record) => preferenceText(record.content?.text))
      .filter((text): text is string => Boolean(text));
  }

  async saveTurn(ref: MemoryRef, turn: Turn): Promise<void> {
    // One event, both messages. A question stored without its answer would replay as a
    // dangling user turn, and the extraction strategies would see half a conversation.
    await this.client.send(new CreateEventCommand({
      memoryId: this.memoryId,
      actorId: ref.actorId,
      sessionId: ref.sessionId,
      eventTimestamp: new Date(),
      payload: [
        { conversational: { role: 'USER', content: { text: turn.user } } },
        { conversational: { role: 'ASSISTANT', content: { text: turn.assistant } } },
      ],
    }));
  }
}

/**
 * The useful sentence inside a stored preference record.
 *
 * The USER_PREFERENCE strategy does not store prose — it stores a serialised JSON object
 * (`{"context": ..., "preference": ..., "categories": [...]}`), verified against real
 * extracted records rather than assumed. Only `preference` is worth putting in front of
 * the model: `context` restates the turn it was extracted from, and `categories` are
 * retrieval metadata. Handing over the whole blob would spend three fields of tokens on
 * one field of meaning, every turn.
 *
 * Falls back to the raw text, because the shape of an extracted record is AWS's to
 * change and a prompt line that reads oddly beats a preference silently dropped.
 */
export function preferenceText(raw: string | undefined): string | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { preference?: unknown };
    if (typeof parsed.preference === 'string' && parsed.preference.trim()) {
      return parsed.preference.trim();
    }
  } catch {
    /* not JSON — an older record, or a strategy that stores plain text */
  }
  return text;
}

/**
 * Bedrock Converse rejects a message list that does not strictly alternate starting with
 * `user`, and rejects the whole turn — so one malformed stored event would make every
 * later turn in that session fail permanently. A turn whose save half-succeeded, or a
 * payload written by an older version of this code, is exactly that. We drop what breaks
 * the pattern instead of forwarding it: losing a line of history beats losing the session.
 */
export function alternating(messages: Message[]): Message[] {
  const kept: Message[] = [];
  let expected: 'user' | 'assistant' = 'user';
  for (const message of messages) {
    if (message.role !== expected) continue;
    kept.push(message);
    expected = expected === 'user' ? 'assistant' : 'user';
  }
  // A trailing user message would collide with the incoming one; drop it.
  if (kept.at(-1)?.role === 'user') kept.pop();
  return kept;
}

/** The store the current environment can actually use. */
export function memoryStoreFromEnv(memoryId = process.env.MEMORY_ID): MemoryStore {
  return memoryId ? new AgentCoreMemoryStore(memoryId) : new NullMemoryStore();
}
