import { type Trace } from '../observability/trace.js';
import { McpClient, McpError, type McpToolResult } from '../mcp/client.js';
import { stripTargetPrefix } from '../gateway/naming.js';
import { type ToolOutcome, type ToolProvider, type ToolSpec } from './provider.js';

/**
 * Tools served by AgentCore Gateway.
 *
 * Two things move out of this process when a tool moves behind the Gateway: the
 * execution, and — the part that matters — the authorization decision. `guard.ts` is not
 * consulted here. If it were, our own code would refuse the call first and the Gateway
 * interceptor we deployed would never run, so the deployment would prove nothing. The
 * denial in this path comes back over the wire from the interceptor.
 */

/*
 * The Gateway advertises `travel_tools___get_weather`; we advertise `get_weather` to the
 * model and map back on the way out. The prompt, the spans, the `toolCalls` list and the
 * smoke tests then keep naming a tool the way the source file does, which is the only
 * reason to bother: an infrastructure detail should not rename the domain.
 */

/**
 * Somewhere to keep the tool list across turns.
 *
 * A `GatewayToolProvider` is built per turn, because the bearer token it carries belongs
 * to one caller. The *catalogue* does not: the interceptor deliberately does not filter
 * `tools/list`, so every caller is shown the same tools and only the call is refused.
 * That is what makes a container-level cache correct here rather than a leak of one
 * user's permissions into another's turn.
 */
export interface ToolSpecCache {
  specs?: Promise<readonly ToolSpec[]>;
  gatewayNames?: Map<string, string>;
}

export class GatewayToolProvider implements ToolProvider {
  /** short name -> the name the Gateway knows it by */
  private readonly gatewayNames: Map<string, string>;

  constructor(
    private readonly client: McpClient,
    private readonly cache: ToolSpecCache = {},
  ) {
    this.gatewayNames = (cache.gatewayNames ??= new Map());
  }

  /**
   * Memoised: `tools/list` is a network round trip on the critical path of a turn, and the
   * answer only changes when we deploy. The first turn in a container pays for it.
   */
  list(): Promise<readonly ToolSpec[]> {
    this.cache.specs ??= (async () => {
      const tools = await this.client.listTools();
      return tools.map((tool) => {
        const name = stripTargetPrefix(tool.name);
        this.gatewayNames.set(name, tool.name);
        return {
          name,
          description: tool.description ?? '',
          // The Gateway echoes back the JSON Schema we registered with the target, so the
          // model sees the same contract whether the tool ran here or there.
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        };
      });
    })();
    return this.cache.specs;
  }

  async call(name: string, input: unknown, trace: Trace): Promise<ToolOutcome> {
    // The agent lists before it calls, so this is normally warm; the await is what makes
    // a direct call safe rather than a lookup miss.
    await this.list();
    const gatewayName = this.gatewayNames.get(name);
    if (!gatewayName) return { error: `Unknown tool "${name}".`, blocked: true };

    try {
      const result = await trace.span(
        'tool.gateway_call',
        { tool: name, gatewayTool: gatewayName, input },
        () => this.client.callTool(gatewayName, input),
      );
      return interpret(result);
    } catch (err) {
      // A transport or protocol failure, not a tool failure: the Gateway was unreachable,
      // timed out, or refused the token. It returns to the model as a tool error like any
      // other, because a turn that cannot reach one tool can still answer with the rest.
      return { error: err instanceof McpError ? `Gateway call failed: ${err.message}` : `Unexpected error: ${err}` };
    }
  }
}

/**
 * Turns an MCP tool result into our outcome shape.
 *
 * The interceptor signals a scope denial as JSON with `blocked: true` inside the error
 * content — a structured marker rather than a string match, because a message we later
 * reword must not silently stop counting as a security event.
 */
export function interpret(result: McpToolResult): ToolOutcome {
  const payload = decodeContent(result);

  if (result.isError) {
    const asObject = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined;
    return {
      error: typeof asObject?.error === 'string' ? asObject.error : textOf(result) || 'the tool reported an error',
      blocked: asObject?.blocked === true,
    };
  }

  return { output: payload };
}

/**
 * Our Lambda targets return objects, and the Gateway hands them to the client as a JSON
 * string in a text block. Parsing it back means the model receives the same structured
 * `tool_result` it got when the tool ran in process — the alternative is a JSON string
 * inside a JSON field, which the model reads perfectly well and then quotes badly.
 */
function decodeContent(result: McpToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;

  const text = textOf(result);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

const textOf = (result: McpToolResult): string =>
  result.content
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
