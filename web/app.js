/*
 * The whole login flow, hand-written — ADR-0007.
 *
 * Authorization code + PKCE against the Cognito hosted UI, then one POST to the API with the
 * resulting access token. No framework, no bundler, no refresh handling: on a 401 you log in
 * again, because a token lasts an hour and a refresh loop is a feature of a real app.
 *
 * Nothing here is a security control. The API Gateway authorizer validates the token, the BFF
 * derives the session id from it, and the Gateway interceptor decides per tool call — all
 * server-side, all unreachable from this file. What this page can do is *display* those
 * decisions, which is the entire reason it exists.
 */

const cfg = window.APP_CONFIG;
const $ = (id) => document.getElementById(id);

const TOKEN_KEY = 'ta.access_token';
const VERIFIER_KEY = 'ta.pkce_verifier';

// ── PKCE ────────────────────────────────────────────────────────────────────────
// base64url, and specifically *without* padding. Cognito rejects a padded challenge with a
// bare `invalid_grant` at the token endpoint — an error that names neither the field nor the
// reason, and that arrives a full redirect after the mistake was made.
function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function newVerifier() {
  // 32 random bytes → 43 base64url characters, the minimum RFC 7636 allows.
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// ── the token, such as we can read it ───────────────────────────────────────────
/*
 * Decoded, never verified. Verifying a token in the page that received it proves nothing —
 * the code doing the checking is the code an attacker would replace. API Gateway's Cognito
 * authorizer is the only verification that counts; this is here to show a human what the
 * thing in their sessionStorage actually says.
 */
function readToken(jwt) {
  try {
    const [, payload] = jwt.split('.');
    const bytes = Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

const expired = (claims) => !claims?.exp || claims.exp * 1000 <= Date.now();

// ── flow ────────────────────────────────────────────────────────────────────────
async function login() {
  const scopes = [...$('scopes').querySelectorAll('input:checked')].map((i) => i.value);
  if (scopes.length === 0) {
    return fail('Pick at least one scope. A token with none is refused by the BFF with a 403 '
      + 'before it reaches the model — deliberately, since every tool would fail anyway.');
  }

  const verifier = newVerifier();
  // sessionStorage, not localStorage: the verifier is single-use and belongs to this tab's
  // redirect. Outliving the tab would only widen the window in which it could be stolen.
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: scopes.join(' '),
    code_challenge_method: 'S256',
    code_challenge: await challengeFor(verifier),
  });
  location.assign(`${cfg.hostedUi}/oauth2/authorize?${q}`);
}

async function exchange(code) {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error('no PKCE verifier in this tab — start the login again');

  const res = await fetch(`${cfg.hostedUi}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    // No client secret, and no Authorization header: this is a public client. The verifier
    // is what proves the exchange comes from whoever started the redirect.
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: cfg.clientId,
      code,
      redirect_uri: cfg.redirectUri,
      code_verifier: verifier,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${body.error ?? 'unknown'}`);
  sessionStorage.removeItem(VERIFIER_KEY);
  return body.access_token;
}

function logout() {
  sessionStorage.removeItem(TOKEN_KEY);
  const q = new URLSearchParams({ client_id: cfg.clientId, logout_uri: cfg.redirectUri });
  // Cognito's own session has to go too, or the next login silently reuses it and the new
  // scope selection never reaches the authorize endpoint — which reads as "the checkbox did
  // nothing". This is the whole reason there is a Log out button on a throwaway harness.
  location.assign(`${cfg.hostedUi}/logout?${q}`);
}

async function ask(prompt) {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const res = await fetch(cfg.apiUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      // Not authentication. It attaches the request to the usage plan that caps the account
      // at 100 turns a day, which is the budget control — see the note in the footer.
      'x-api-key': cfg.apiKey,
    },
    // `prompt` and nothing else. Sending a sessionId, actorId or scopes would be an attempt
    // to read another user's memory or widen this token; the BFF ignores all three and logs
    // the attempt as blocked, so the page does not even offer the shape.
    body: JSON.stringify({ prompt }),
  });

  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    render();
    throw new Error('the token expired — log in again');
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${body.error ?? 'the API refused the request'}${body.detail ? `\n${body.detail}` : ''}`);
  return body;
}

// ── rendering ───────────────────────────────────────────────────────────────────
function fail(message) {
  const el = $('error');
  el.textContent = message;
  el.hidden = false;
}

function clearError() { $('error').hidden = true; }

function render() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const claims = token ? readToken(token) : null;
  const signedIn = Boolean(claims) && !expired(claims);

  if (token && !signedIn) sessionStorage.removeItem(TOKEN_KEY);

  $('anon').hidden = signedIn;
  $('signed-in').hidden = !signedIn;
  if (!signedIn) return;

  // Showing the granted scopes is half the demonstration: the list below is what the Gateway
  // interceptor will be handed, so a missing entry here is a refusal you can predict.
  const granted = (claims.scope ?? '').split(' ').filter(Boolean);
  $('identity').innerHTML = [
    ['sub', claims.sub],
    ['username', claims.username ?? claims.client_id ?? '—'],
    ['client_id', claims.client_id ?? '—'],
    ['granted scopes', granted.length ? granted.join('\n') : '(none)'],
    ['expires', new Date(claims.exp * 1000).toLocaleTimeString()],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v)).replace(/\n/g, '<br>')}</dd>`).join('');
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderAnswer(body) {
  $('answer').hidden = false;
  $('answer-text').textContent = body.response || '(the agent returned nothing)';

  // One badge per tool call, red when the interceptor refused it. This row is the acceptance
  // test made visible: with photos:search unchecked, `get_photos` appears here as blocked
  // while `get_weather` succeeds, and the answer above explains the gap honestly.
  $('tools').innerHTML = (body.toolCalls ?? [])
    .map((c) => `<span class="badge ${c.blocked ? 'blocked' : 'ok'}">${escapeHtml(c.name)}${c.blocked ? ' · blocked' : ''}</span>`)
    .join('') || '<span class="meta">no tool calls</span>';

  // `build` is the container image tag that answered. After a deploy a 200 can still come
  // from the previous warm container, and this field is the only way to tell.
  $('meta').textContent = `build ${body.build ?? '?'} · session ${String(body.sessionId ?? '').slice(0, 12)}… · trace ${body.traceId ?? '?'}`;
}

// ── wiring ──────────────────────────────────────────────────────────────────────
$('login').addEventListener('click', () => { clearError(); login().catch((e) => fail(e.message)); });
$('logout').addEventListener('click', logout);

$('ask').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();
  const prompt = $('prompt').value.trim();
  if (!prompt) return;
  $('send').disabled = true;
  $('send').textContent = 'Thinking…';
  try {
    renderAnswer(await ask(prompt));
  } catch (e) {
    $('answer').hidden = true;
    fail(e.message);
  } finally {
    $('send').disabled = false;
    $('send').textContent = 'Send';
  }
});

(async function start() {
  if (!cfg?.clientId) {
    return fail('web/config.js is missing or empty. Generate it against a deployed stack:\n'
      + '  ./scripts/web-config.sh');
  }

  const params = new URLSearchParams(location.search);
  if (params.has('error')) {
    // Straight from Cognito. `redirect_mismatch` here means the callback URL in the stack and
    // `cfg.redirectUri` disagree — most often by a trailing slash.
    fail(`Cognito refused the login: ${params.get('error')} — ${params.get('error_description') ?? ''}`);
  } else if (params.has('code')) {
    try {
      sessionStorage.setItem(TOKEN_KEY, await exchange(params.get('code')));
    } catch (e) {
      fail(e.message);
    }
  }
  // Drop the code from the address bar either way: it is single-use, and leaving it there
  // means a reload tries to spend it again and fails with an error about the wrong thing.
  if (params.has('code') || params.has('error')) history.replaceState({}, '', location.pathname);

  render();
})();
