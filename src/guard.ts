import { type Tool } from './tools/index.js';
import { type Trace } from './observability/trace.js';

/**
 * Local equivalent of AgentCore Gateway inbound interceptors.
 *
 * After deployment this decision is made by the Gateway from the scopes in the
 * Cognito token (["weather:read", "photos:search"] on the second diagram). We keep
 * the same logic locally so it can be tested without AWS, and so a denial leaves
 * an identical trace before and after deployment.
 */

export interface Decision {
  allowed: boolean;
  reason?: string;
}

export function authorize(tool: Tool, grantedScopes: readonly string[], trace: Trace): Decision {
  if (grantedScopes.includes(tool.requiredScope)) return { allowed: true };

  // This is exactly the span from the diagram: interceptor caught it, call was blocked.
  trace.blocked('tool.authorize', {
    tool: tool.name,
    requiredScope: tool.requiredScope,
    grantedScopes,
    decision: 'deny',
  });

  return {
    allowed: false,
    reason: `Missing scope "${tool.requiredScope}" required by ${tool.name}.`,
  };
}

/** Default scope set for local runs — full access. */
export const ALL_SCOPES = ['places:read', 'weather:read', 'photos:search', 'flights:read'] as const;
