import { BedrockAgentCoreClient, GetResourceApiKeyCommand } from '@aws-sdk/client-bedrock-agentcore';
import { ToolError } from '../tools/types.js';
import { currentWorkloadToken } from './workloadToken.js';

/**
 * Reads an API key out of the AgentCore Identity token vault (ADR-0002).
 *
 * The chain is: Secrets Manager holds the token -> an AgentCore API key credential
 * provider (`duffel-api-key`) points at that secret -> the workload presents its access
 * token to `GetResourceApiKey` and receives the key. The point of the detour is that the
 * container never holds a Secrets Manager permission and never sees the secret's ARN: it
 * asks Identity for "the key for this provider" and Identity decides whether this
 * workload may have it.
 *
 * Deliberately not `secretsmanager:GetSecretValue` from the runtime role, which would be
 * two lines shorter and would skip the layer the project exists to exercise.
 */

/** Per-container cache. The key is the same for every caller, so it is not per-session. */
const cache = new Map<string, string>();

let sharedClient: BedrockAgentCoreClient | undefined;

const client = (): BedrockAgentCoreClient =>
  (sharedClient ??= new BedrockAgentCoreClient({ region: process.env.AWS_REGION ?? 'us-east-1' }));

/** How the key was actually obtained. Logged; the key itself never is. */
export type ApiKeySource = 'env' | 'identity' | 'cache';

export interface ApiKeyFetcher {
  (args: { workloadToken: string; providerName: string }): Promise<string>;
}

const fetchFromIdentity: ApiKeyFetcher = async ({ workloadToken, providerName }) => {
  const res = await client().send(new GetResourceApiKeyCommand({
    workloadIdentityToken: workloadToken,
    resourceCredentialProviderName: providerName,
  }));
  if (!res.apiKey) {
    throw new ToolError(`AgentCore Identity returned no API key for provider "${providerName}"`);
  }
  return res.apiKey;
};

/**
 * The key for one credential provider, cached for the life of the container.
 *
 * Caching is what keeps the Identity call off the per-tool-call path: a static API key
 * does not change between turns, and the container is session-scoped anyway. The cost is
 * staleness if the secret is rotated mid-session, which `invalidate()` below repairs —
 * see the 401 handling in the Duffel client.
 */
export async function resourceApiKey(
  providerName: string,
  deps: { fetch?: ApiKeyFetcher } = {},
): Promise<{ key: string; source: ApiKeySource }> {
  const cached = cache.get(providerName);
  if (cached) return { key: cached, source: 'cache' };

  const workloadToken = currentWorkloadToken();
  if (!workloadToken) {
    // Fail with the reason, not with a generic auth error: the only way this happens in
    // the cloud is AgentCore not delivering the header, and that is a different problem
    // from a missing secret or a rejected key.
    throw new ToolError(
      'No workload access token on this invocation, so the AgentCore Identity token vault ' +
      'cannot be read. Expected AgentCore Runtime to deliver it as a request header.',
    );
  }

  const key = await (deps.fetch ?? fetchFromIdentity)({ workloadToken, providerName });
  cache.set(providerName, key);
  return { key, source: 'identity' };
}

/**
 * Drops a cached key.
 *
 * Called when the third-party API rejects the credential: a container that cached a key
 * the moment before the secret was rotated would otherwise keep failing for the rest of
 * its life, and every later turn in that session would look like a broken tool.
 */
export const invalidateResourceApiKey = (providerName: string): void => {
  cache.delete(providerName);
};

/** Tests only — the cache is module state and must not leak between cases. */
export const clearApiKeyCache = (): void => cache.clear();
