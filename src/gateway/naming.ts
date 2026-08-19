/**
 * How AgentCore Gateway names the tools it serves.
 *
 * The Gateway prefixes every tool with the name of the target it came from, joined by a
 * triple underscore: `travel_tools___get_weather`. Three components have to agree on this
 * string — the agent's MCP client strips it, the target Lambda strips it to dispatch, and
 * the interceptor strips it to find the required scope — so it lives in one file rather
 * than three times as a literal.
 *
 * The delimiter is AWS's choice, not ours, and the docs say the prefix must be stripped in
 * the Lambda by hand.
 */

export const TARGET_DELIMITER = '___';

/**
 * Name of the single Gateway target holding our keyless tools. Must match the CDK.
 *
 * Hyphens, not underscores. Gateway and gateway-target names are validated against
 * `^([0-9a-zA-Z][-]?){1,100}$`, which forbids `_` — the exact opposite of the Runtime,
 * whose name *must* be `travel_assistant` with underscores. Two AgentCore resources, two
 * incompatible naming rules; `cdk synth` catches it, a careless copy of the runtime's
 * convention would not.
 */
export const TOOL_TARGET_NAME = 'travel-tools';

export const stripTargetPrefix = (gatewayName: string): string => {
  const at = gatewayName.indexOf(TARGET_DELIMITER);
  return at === -1 ? gatewayName : gatewayName.slice(at + TARGET_DELIMITER.length);
};

export const gatewayToolName = (toolName: string): string =>
  `${TOOL_TARGET_NAME}${TARGET_DELIMITER}${toolName}`;
