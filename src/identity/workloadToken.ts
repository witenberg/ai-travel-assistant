import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The workload access token — how code inside the Runtime proves it is this agent.
 *
 * This was the open unknown in ROADMAP step 2, and the answer is documented rather than
 * guessed: AgentCore Runtime "passes the workload access token to agent code as part of
 * the invocation payload header". So the token is not something we fetch — it is handed
 * to us on the `POST /invocations` request, per turn, and our job is to pick it up.
 *
 * The alternative we cannot use: calling `GetWorkloadAccessToken` ourselves. The docs are
 * explicit that "Runtime-managed and Gateway-managed workload identities cannot retrieve
 * tokens directly. This prevents agents from extracting tokens for misuse" — which is
 * exactly the error we hit from the CLI ("WorkloadIdentity is linked to a service and
 * cannot retrieve an access token by the caller"). That is a permanent design property,
 * not a permissions gap, so the header is the only path and there is no fallback to write.
 *
 * Header names are taken from the official Python SDK's own constants
 * (`bedrock_agentcore/runtime/models.py`), because the devguide names only the first:
 *   ACCESS_TOKEN_HEADER = "WorkloadAccessToken"
 *   IDENTITY_WAT_HEADER = "X-Amz-Bedrock-AgentCore-Identity-WAT"
 * Node lowercases incoming header names, so both constants here are lowercase.
 */

/** Preferred: the identity WAT header, which is also allowlisted for chain propagation. */
export const IDENTITY_WAT_HEADER = 'x-amz-bedrock-agentcore-identity-wat';

/** The older name, and the one the devguide documents. Checked second. */
export const WORKLOAD_ACCESS_TOKEN_HEADER = 'workloadaccesstoken';

export const WORKLOAD_TOKEN_HEADERS = [IDENTITY_WAT_HEADER, WORKLOAD_ACCESS_TOKEN_HEADER] as const;

type Headers = Record<string, string | string[] | undefined>;

const firstValue = (value: string | string[] | undefined): string | undefined =>
  (Array.isArray(value) ? value[0] : value)?.trim() || undefined;

/**
 * Finds the workload access token on an invocation request.
 *
 * Returns which header carried it as well as the token, because that name is the only
 * part of this that is safe to log — and knowing *which* of the two names AgentCore
 * actually used is worth recording once, so the next person does not have to re-derive it.
 */
export function workloadTokenFromHeaders(headers: Headers): { token: string; header: string } | undefined {
  for (const name of WORKLOAD_TOKEN_HEADERS) {
    const token = firstValue(headers[name]);
    if (token) return { token, header: name };
  }
  return undefined;
}

/**
 * Request-scoped storage for the token.
 *
 * `AsyncLocalStorage` rather than a module-level variable or an extra parameter on
 * `Tool.execute`. A module-level variable would leak one caller's token into another
 * turn the moment two invocations overlap — and `/ping` reporting `HealthyBusy` exists
 * precisely because overlap is possible. Threading a parameter through `runAgent` ->
 * `ToolProvider` -> `Tool.execute` -> the Duffel client would put an identity concern in
 * four signatures that have no other reason to know about it; only one tool needs the
 * token, and it needs it three calls deep.
 */
const store = new AsyncLocalStorage<string | undefined>();

/** Runs `fn` with the turn's workload access token available to anything it calls. */
export const runWithWorkloadToken = <T>(token: string | undefined, fn: () => T): T =>
  store.run(token, fn);

/** The current turn's workload access token, if AgentCore delivered one. */
export const currentWorkloadToken = (): string | undefined => store.getStore();
