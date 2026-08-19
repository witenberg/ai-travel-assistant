import type { CfnGatewayTarget } from 'aws-cdk-lib/aws-bedrockagentcore';
import type { Tool } from '../../src/tools/index.js';

/**
 * Turns our tools' JSON Schemas into the `ToolDefinition` shape a Gateway target registers.
 *
 * The point of generating this rather than writing it out in the template is that the
 * schema the Gateway advertises and the schema the tool validates against are then the same
 * object. A hand-copied schema in CDK is a second definition of the tool's contract, and
 * the day someone renames a property, the model would be told the old name and the target
 * Lambda would receive `undefined` — a failure that looks like a broken tool, not like
 * drift.
 *
 * `SchemaDefinition` is a *subset* of JSON Schema: type, description, properties, required,
 * items, and nothing else. So the translation below rejects anything it does not recognise
 * instead of dropping it. A silently ignored `enum` would mean the model is free to send a
 * value the tool never expected, and that is exactly the class of bug the schema exists to
 * prevent.
 */

type SchemaDefinition = CfnGatewayTarget.SchemaDefinitionProperty;

/** Keys of JSON Schema that AgentCore's SchemaDefinition understands. */
const SUPPORTED_KEYS = new Set(['type', 'description', 'properties', 'required', 'items']);

export function toSchemaDefinition(schema: Record<string, unknown>, at = 'inputSchema'): SchemaDefinition {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYS.has(key)) {
      throw new Error(
        `${at}: AgentCore SchemaDefinition has no "${key}" — either drop it from the tool's ` +
          `schema or teach this converter about it. Silently ignoring it would let the model ` +
          `send input the tool does not accept.`,
      );
    }
  }

  const type = schema.type;
  if (typeof type !== 'string') throw new Error(`${at}: every schema node needs a string "type"`);

  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const items = schema.items as Record<string, unknown> | undefined;

  return {
    type,
    ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
    ...(Array.isArray(schema.required) ? { required: schema.required as string[] } : {}),
    ...(properties
      ? {
          properties: Object.fromEntries(
            Object.entries(properties).map(([name, child]) => [
              name,
              toSchemaDefinition(child, `${at}.${name}`),
            ]),
          ),
        }
      : {}),
    ...(items ? { items: toSchemaDefinition(items, `${at}.items`) } : {}),
  };
}

/**
 * One `ToolDefinition` per tool, in the order the registry lists them.
 *
 * No `outputSchema`. It is optional, and our tools answer with shapes that vary by outcome
 * — `{ found: false, message }` for a place that does not exist, a full forecast otherwise.
 * Declaring one shape would either be a lie or force the tools to pad their answers.
 */
export const toolDefinitions = (tools: readonly Tool[]): CfnGatewayTarget.ToolDefinitionProperty[] =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toSchemaDefinition(tool.inputSchema as Record<string, unknown>, `${tool.name}.inputSchema`),
  }));
