import { type Tool, type ToolSpec } from './types.js';
import { getWeather } from './getWeather.js';
import { getPlaceDetails } from './getPlaceDetails.js';
import { getPhotos } from './getPhotos.js';
import { searchFlights } from './searchFlights.js';

export const TOOLS: readonly Tool[] = [getPlaceDetails, getWeather, getPhotos, searchFlights];

/**
 * Tools served by AgentCore Gateway as one Lambda target.
 *
 * The three keyless ones. They move because moving them is what buys the Gateway's
 * inbound authorization: a scope denial becomes AWS's decision rather than ours, made
 * before our code runs at all.
 */
export const GATEWAY_TOOLS: readonly Tool[] = [getPlaceDetails, getWeather, getPhotos];

/**
 * Tools still executed inside the Runtime container.
 *
 * Only `search_flights`, and deliberately: ADR-0002 routes its Duffel token through the
 * AgentCore Identity token vault, which the Runtime's workload identity can reach and a
 * Gateway Lambda target cannot. Sending it through the Gateway would mean either handing
 * the model raw Duffel JSON via an OpenAPI target — rejected in ADR-0002 — or reading the
 * secret straight from Secrets Manager in the target Lambda, which throws away the
 * Identity layer we built the tool to exercise.
 */
export const LOCAL_TOOLS: readonly Tool[] = TOOLS.filter((t) => !GATEWAY_TOOLS.includes(t));

export const byName = (name: string): Tool | undefined => TOOLS.find((t) => t.name === name);

/**
 * Translates tool specs into the Bedrock Converse API toolConfig.
 *
 * Takes `ToolSpec`, not `Tool`: after Step 4 some of these specs come back from
 * AgentCore Gateway over MCP and have no `execute` to call. What the model is shown and
 * what runs the work are two different things, and this function only knows the first.
 */
export const toolConfig = (tools: readonly ToolSpec[] = TOOLS) => ({
  tools: tools.map((t) => ({
    // The SDK expects DocumentType; our JSON Schema conforms, but the SDK type is wider.
    toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema as any } },
  })),
});

export * from './types.js';
export { getWeather, getPlaceDetails, getPhotos, searchFlights };
