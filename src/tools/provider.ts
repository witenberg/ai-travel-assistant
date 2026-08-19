import { type Trace } from '../observability/trace.js';
import { authorize } from '../guard.js';
import { TOOLS, ToolError, type Tool, type ToolSpec } from './index.js';

/**
 * Where the agent gets its tools from.
 *
 * The same seam idea as `MemoryStore` and `guard.ts`: one interface, one local
 * implementation that needs no AWS, one that talks to the deployed component. The agent
 * loop asks a provider what tools exist and to run one; it does not know whether the
 * work happens in this process or behind AgentCore Gateway.
 *
 * The interface is deliberately narrower than `Tool`. A provider advertises a name, a
 * description and an input schema, because that is all the model is told, and it returns
 * an outcome rather than throwing, because "you were not allowed to call that" is a
 * normal answer in this system and not an exception.
 */

export { type ToolSpec } from './types.js';

/**
 * The result of one tool call.
 *
 * `blocked` is separate from `error` on purpose. Both come back to the model as a failed
 * `tool_result`, but only one of them is a security event, and the difference is what the
 * `toolCalls` list in the response and the spans in CloudWatch are built on.
 */
export interface ToolOutcome {
  readonly output?: unknown;
  readonly error?: string;
  readonly blocked?: boolean;
}

export interface ToolProvider {
  /** Tool specs to advertise to the model. May involve I/O — the Gateway is asked. */
  list(): Promise<readonly ToolSpec[]>;
  /** Runs one tool. Never throws for an expected failure; see `ToolOutcome`. */
  call(name: string, input: unknown, trace: Trace): Promise<ToolOutcome>;
}

export const specOf = (tool: Tool): ToolSpec => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema as Record<string, unknown>,
});

/**
 * Tools executed inside this process, with `guard.ts` deciding what is allowed.
 *
 * This is what `npm run dev` and every test uses, and after Step 4 it is still the
 * execution path for `search_flights` — the one tool whose credential comes from the
 * AgentCore Identity token vault (ADR-0002) rather than from the Gateway.
 */
export class LocalToolProvider implements ToolProvider {
  constructor(
    private readonly tools: readonly Tool[] = TOOLS,
    private readonly scopes: readonly string[] = [],
  ) {}

  async list(): Promise<readonly ToolSpec[]> {
    return this.tools.map(specOf);
  }

  async call(name: string, input: unknown, trace: Trace): Promise<ToolOutcome> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) return { error: `Unknown tool "${name}".`, blocked: true };

    const decision = authorize(tool, this.scopes, trace);
    if (!decision.allowed) return { error: decision.reason, blocked: true };

    try {
      const output = await trace.span('tool.execute', { tool: name, input }, () =>
        tool.execute(input as never),
      );
      return { output };
    } catch (err) {
      // A tool failure returns to the model as a tool_result rather than killing the
      // turn. The model can then try a different route, or tell the user what was missing.
      return { error: err instanceof ToolError ? err.message : `Unexpected error: ${err}` };
    }
  }
}

/**
 * Several providers behind one interface, first match wins.
 *
 * This exists because Step 4 moves three tools behind the Gateway and leaves
 * `search_flights` in process. Routing by name rather than by trying each provider in
 * turn is the important part: a "try the next one" fallback would execute a tool locally
 * after the Gateway refused it, which is a way around the authorization we just deployed.
 */
export class CompositeToolProvider implements ToolProvider {
  private readonly owner = new Map<string, ToolProvider>();

  constructor(private readonly providers: readonly ToolProvider[]) {}

  async list(): Promise<readonly ToolSpec[]> {
    const specs: ToolSpec[] = [];
    for (const provider of this.providers) {
      for (const spec of await provider.list()) {
        // First provider to claim a name keeps it, so the order of `providers` is the
        // precedence order. A duplicate name is a configuration mistake, not a merge.
        if (this.owner.has(spec.name)) continue;
        this.owner.set(spec.name, provider);
        specs.push(spec);
      }
    }
    return specs;
  }

  async call(name: string, input: unknown, trace: Trace): Promise<ToolOutcome> {
    // The routing table is a by-product of `list()`. The agent always lists before it
    // calls, but a provider whose contract only works in that order is a trap, so a
    // caller that skips it gets the table built here instead of a spurious "unknown tool".
    if (this.owner.size === 0) await this.list();

    const provider = this.owner.get(name);
    if (!provider) return { error: `Unknown tool "${name}".`, blocked: true };
    return provider.call(name, input, trace);
  }
}
