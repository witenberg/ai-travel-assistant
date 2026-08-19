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

export const DEFAULT_MODEL_ID =
  process.env.MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

/** Loop iteration ceiling — budget protection against a looping agent. */
const MAX_TURNS = 6;

export interface AgentOptions {
  sessionId: string;
  scopes?: readonly string[];
  modelId?: string;
  /** Conversation history from previous turns (eventually from AgentCore Memory). */
  history?: Message[];
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
    history = [],
    client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1' }),
  } = opts;

  const trace = new Trace(sessionId);
  const messages: Message[] = [...history, { role: 'user', content: [{ text: userMessage }] }];
  const toolCalls: AgentResult['toolCalls'] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await trace.span('model.converse', { modelId, turn }, () =>
      client.send(
        new ConverseCommand({
          modelId,
          system: [{ text: buildSystemPrompt() }],
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
      return { answer: textOf(reply.content ?? []), messages, traceId: trace.traceId, toolCalls };
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
