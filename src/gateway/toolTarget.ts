import { GATEWAY_TOOLS, ToolError, type Tool } from '../tools/index.js';
import { stripTargetPrefix } from './naming.js';
import { Trace } from '../observability/trace.js';

/**
 * Lambda target behind AgentCore Gateway: one function, three tools.
 *
 * The tools themselves are unchanged — this file imports the same `getWeather` the local
 * agent used to call in process. That is the point of keeping `Tool` free of any Bedrock
 * or Lambda types: moving execution to another compute plane is a new entry point, not a
 * rewrite, and the existing tool tests still cover the logic.
 *
 * One function for all three rather than one per tool. Three functions would give three
 * cold starts, three log groups and three CDK constructs to buy nothing: the tools share
 * their HTTP client and their geocoder, none of them needs a different timeout or memory
 * size, and the Gateway target already namespaces them.
 */

/** The subset of the Lambda context we read. Typed here to avoid an `@types/aws-lambda` dep. */
export interface GatewayLambdaContext {
  clientContext?: {
    custom?: {
      bedrockAgentCoreToolName?: string;
      bedrockAgentCoreMcpMessageId?: string;
      bedrockAgentCoreGatewayId?: string;
      bedrockAgentCoreTargetId?: string;
      bedrockAgentCoreAwsRequestId?: string;
      [key: string]: string | undefined;
    };
  };
  awsRequestId?: string;
}

export function createToolTargetHandler(tools: readonly Tool[] = GATEWAY_TOOLS) {
  return async function handler(event: unknown, context: GatewayLambdaContext): Promise<unknown> {
    const custom = context.clientContext?.custom ?? {};
    const advertisedName = custom.bedrockAgentCoreToolName;

    /*
     * The correlation id is this invocation's own request id, **not** our runtime session id.
     * AgentCore does not forward the caller's `Mcp-Session-Id` to a Lambda target — the
     * target receives only the tool arguments and the ids below — so the
     * Session -> trace -> span chain cannot be continued from inside this function.
     * Correlate a tool execution to a conversation through the interceptor's span instead;
     * the interceptor can carry the session id because it sees the request headers.
     *
     * `bedrockAgentCoreMcpMessageId` deliberately is *not* used for this, and the first
     * deployed run is why: it logged `"sessionId": "4"`. The MCP message id is the
     * JSON-RPC id, a per-connection counter that restarts at 1 for every conversation — so
     * as a correlation key it is worse than useless, because two unrelated turns collide on
     * the same value. It is kept as an attribute, where a low-cardinality number is honest.
     */
    const trace = new Trace(context.awsRequestId ?? custom.bedrockAgentCoreAwsRequestId ?? 'unknown');
    const attributes = {
      gatewayId: custom.bedrockAgentCoreGatewayId,
      targetId: custom.bedrockAgentCoreTargetId,
      mcpMessageId: custom.bedrockAgentCoreMcpMessageId,
    };

    if (!advertisedName) {
      // Only reachable if AgentCore changes the context contract. Failing loudly beats
      // guessing a tool from the shape of its arguments.
      throw new Error('the invocation carries no bedrockAgentCoreToolName');
    }

    // The advertised name is `<target>___<tool>`; the docs are explicit that stripping the
    // prefix is the function's job.
    const name = stripTargetPrefix(advertisedName);
    const tool = tools.find((t) => t.name === name);

    if (!tool) {
      // A tool the Gateway advertises and this function cannot serve means the target's
      // registered schema and this code have drifted apart — a deploy problem, not a
      // request problem, so it is an exception rather than a tool-level error.
      throw new Error(`no tool named "${name}" in this target`);
    }

    try {
      return await trace.span('gateway.tool.execute', { tool: name, ...attributes }, () =>
        tool.execute(event as never),
      );
    } catch (err) {
      const message = err instanceof ToolError ? err.message : `Unexpected error: ${err}`;
      /*
       * A failing tool returns its failure as data, the same way `get_weather` already
       * answers `{ found: false }` for a place that does not exist. Throwing would make
       * the Gateway report a protocol-level error whose text we do not control, and the
       * model needs the reason in words to tell the user what was missing. The span above
       * has already recorded this as an `error`, so the failure is visible in CloudWatch
       * even though the MCP call itself succeeded.
       */
      return { error: message };
    }
  };
}

export const handler = createToolTargetHandler();
