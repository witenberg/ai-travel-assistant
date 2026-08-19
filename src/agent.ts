import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { TOOLS, byName, toolConfig, ToolError } from './tools/index.js';
import { authorize, ALL_SCOPES } from './guard.js';
import { Trace } from './observability/trace.js';
import { buildSystemPrompt } from './prompt.js';
import { NullMemoryStore, type MemoryStore, type MemoryRef } from './memory/store.js';

export const DEFAULT_MODEL_ID =
  process.env.MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

/** Loop iteration ceiling — budget protection against a looping agent. */
const MAX_TURNS = 6;

export interface AgentOptions {
  sessionId: string;
  scopes?: readonly string[];
  modelId?: string;
  /**
   * Conversation history from previous turns. When omitted it is loaded from `memory`;
   * passing it explicitly bypasses the store, which is how tests pin a conversation.
   */
  history?: Message[];
  /** The person behind the session. Long-term recall is keyed on this, not on the session. */
  actorId?: string;
  /** AgentCore Memory. Defaults to a no-op so a local run needs no AWS resource. */
  memory?: MemoryStore;
  client?: BedrockRuntimeClient;
}

export interface AgentResult {
  answer: string;
  messages: Message[];
  traceId: string;
  toolCalls: { name: string; blocked: boolean }[];
}

export async function runAgent(userMessage: string, opts: AgentOptions): Promise<AgentResult> {
  const {
    sessionId,
    scopes = ALL_SCOPES,
    modelId = DEFAULT_MODEL_ID,
    actorId = sessionId,
    memory = new NullMemoryStore(),
    client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1' }),
  } = opts;

  const trace = new Trace(sessionId);
  const ref: MemoryRef = { actorId, sessionId };

  const [history, preferences] = await recall(memory, ref, userMessage, opts.history, trace);
  const systemPrompt = buildSystemPrompt(new Date(), preferences);

  const messages: Message[] = [...history, { role: 'user', content: [{ text: userMessage }] }];
  const toolCalls: AgentResult['toolCalls'] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await trace.span('model.converse', { modelId, turn }, () =>
      client.send(
        new ConverseCommand({
          modelId,
          system: [{ text: systemPrompt }],
          messages,
          toolConfig: toolConfig(TOOLS),
          inferenceConfig: { maxTokens: 1500, temperature: 0.3 },
        }),
      ),
    );

    const reply = response.output?.message;
    if (!reply) throw new Error('Bedrock returned no message');
    messages.push(reply);

    if (response.stopReason !== 'tool_use') {
      const answer = textOf(reply.content ?? []);
      await remember(memory, ref, { user: userMessage, assistant: answer }, trace);
      return { answer, messages, traceId: trace.traceId, toolCalls };
    }

    // Tools from one turn run in parallel — the model may request several at once.
    const requests = (reply.content ?? []).filter((b) => b.toolUse);
    const results = await Promise.all(
      requests.map((block) => executeToolBlock(block, scopes, trace, toolCalls)),
    );

    messages.push({ role: 'user', content: results });
  }

  throw new Error(`Agent exceeded the ${MAX_TURNS}-turn limit — possible loop`);
}

/**
 * Reads both halves of memory before the first model call.
 *
 * Concurrently, because they are independent and this sits on the critical path of a
 * turn that already has a ~29 s ceiling (ADR-0001). Failure-tolerant, because memory is
 * an enhancement: an agent that answers without recall is degraded, an agent that
 * refuses to answer because a recall call timed out is broken. The span records the
 * failure either way, so a silently forgetful agent is still visible in CloudWatch.
 */
async function recall(
  memory: MemoryStore,
  ref: MemoryRef,
  userMessage: string,
  explicitHistory: Message[] | undefined,
  trace: Trace,
): Promise<[Message[], string[]]> {
  const load = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await trace.span(name, { actorId: ref.actorId }, fn);
    } catch {
      return fallback; // already recorded as an `error` span by trace.span
    }
  };

  const [history, preferences] = await Promise.all([
    explicitHistory ?? load('memory.load_history', () => memory.loadHistory(ref), []),
    load('memory.load_preferences', () => memory.loadPreferences(ref, userMessage), []),
  ]);

  return [history, preferences];
}

/**
 * Persists the finished turn.
 *
 * Awaited rather than fired and forgotten: in a container that AgentCore may stop as
 * soon as the response is written, a detached promise is a turn that silently never
 * happened. Swallowed on failure for the same reason as `recall` — the user already has
 * their answer, and throwing here would turn a successful turn into a 500.
 */
async function remember(
  memory: MemoryStore,
  ref: MemoryRef,
  turn: { user: string; assistant: string },
  trace: Trace,
): Promise<void> {
  try {
    await trace.span('memory.save_turn', { actorId: ref.actorId }, () => memory.saveTurn(ref, turn));
  } catch {
    /* recorded as an `error` span; the answer stands */
  }
}

async function executeToolBlock(
  block: ContentBlock,
  scopes: readonly string[],
  trace: Trace,
  toolCalls: AgentResult['toolCalls'],
): Promise<ContentBlock> {
  const use = block.toolUse!;
  const name = use.name!;
  const tool = byName(name);

  if (!tool) {
    toolCalls.push({ name, blocked: true });
    return errorResult(use.toolUseId!, `Unknown tool "${name}".`);
  }

  const decision = authorize(tool, scopes, trace);
  if (!decision.allowed) {
    toolCalls.push({ name, blocked: true });
    return errorResult(use.toolUseId!, decision.reason!);
  }

  toolCalls.push({ name, blocked: false });
  try {
    const output = await trace.span('tool.execute', { tool: name, input: use.input }, () =>
      tool.execute(use.input as never),
    );
    return { toolResult: { toolUseId: use.toolUseId!, content: [{ json: output as any }], status: 'success' } };
  } catch (err) {
    // A tool failure returns to the model as a tool_result rather than killing the turn.
    // The model can then try a different route, or tell the user what was missing.
    const message = err instanceof ToolError ? err.message : `Unexpected error: ${err}`;
    return errorResult(use.toolUseId!, message);
  }
}

const errorResult = (toolUseId: string, message: string): ContentBlock => ({
  toolResult: { toolUseId, content: [{ json: { error: message } }], status: 'error' },
});

const textOf = (content: ContentBlock[]): string =>
  content.map((b) => b.text ?? '').filter(Boolean).join('\n').trim();
