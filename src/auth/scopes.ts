import { ALL_SCOPES } from '../guard.js';

/**
 * Reading tool permissions out of a Cognito access token.
 *
 * Shared by the BFF and the Gateway interceptor. They sit on opposite sides of the
 * request and both have to reach the same conclusion from the same token — if one of them
 * kept its own copy of the prefix rule, a scope renamed in Cognito would be honoured in
 * one place and ignored in the other, and the disagreement would look like a bug in the
 * agent rather than in the parsing.
 */

/** The Cognito resource server that carries our tool scopes; its id prefixes every scope. */
export const SCOPE_PREFIX = 'tools/';

const KNOWN_SCOPES: readonly string[] = ALL_SCOPES;

/**
 * Tool scopes granted by the token.
 *
 * Cognito emits the `scope` claim as a space-delimited list of fully qualified scopes
 * (`tools/weather:read`). We strip the resource-server prefix so the rest of the system
 * sees the same short names `guard.ts` uses, and drop anything we do not recognise —
 * `openid`, `aws.cognito.signin.user.admin` and friends are not tool permissions.
 */
export function extractScopes(scopeClaim: string | undefined): string[] {
  if (!scopeClaim) return [];
  return scopeClaim
    .split(/\s+/)
    .filter((s) => s.startsWith(SCOPE_PREFIX))
    .map((s) => s.slice(SCOPE_PREFIX.length))
    .filter((s) => KNOWN_SCOPES.includes(s));
}

/**
 * Reads the claims out of a JWT **without verifying it**.
 *
 * Normally that sentence describes a vulnerability, so it needs its justification next to
 * it: the only caller is the Gateway interceptor, and an interceptor runs *after* the
 * Gateway's `CUSTOM_JWT` authorizer has already validated the signature, the issuer, the
 * expiry and the allowed client against the Cognito discovery document. Re-verifying would
 * mean fetching JWKS on a path that runs inside every tool call, to re-derive a decision
 * AWS just made for us — and a second implementation of a security check is a second
 * chance to get it wrong.
 *
 * The rule this depends on: never call this on a token that has not already been
 * validated by something else. There is no other caller, and there should not be one.
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Pulls the bearer token out of an `Authorization` header, case-insensitively. */
export function bearerToken(headers: Record<string, string | undefined> | undefined): string | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization');
  const value = entry?.[1];
  if (!value) return undefined;
  const match = /^bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}
