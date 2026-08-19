# ADR-0003: Long-term memory is keyed on the actor; short-term memory stores text, not tool traffic

- **Status:** accepted
- **Date:** 2026-08-19
- **Context:** AgentCore Memory was deployed in the first stack and then ignored —
  `MEMORY_ID` reached the container and nothing read it. ROADMAP step 5 turns it on.
  Two questions had to be answered before writing any code, and both are hard to reverse
  once conversations are stored: **what identity does memory hang off**, and **what
  exactly gets written**.

## What the platform offers

Verified against the AgentCore data plane and the CloudFormation registry, not from memory:

- Every event carries **both** an `actorId` and a `sessionId`. `ListEvents` requires both.
- Long-term records are produced asynchronously by **memory strategies**
  (`SEMANTIC`, `SUMMARY`, `USER_PREFERENCE`, `CUSTOM`) that read the stored events and
  write into a **namespace template** — `{actorId}` is substituted by the service.
- `RetrieveMemoryRecords` searches a namespace semantically and returns scored records.
- `eventExpiryDuration` bounds raw events only. Extracted records have their own lifetime.
- Strategies run under a **memory execution role**, separate from the runtime role,
  because the extraction happens on AWS's schedule and not inside our container.

## Decision 1 — actor and session are separate identities

The BFF derives two values from the same verified `sub`, with different domain
separators:

| | derived from | means | scopes |
|---|---|---|---|
| `sessionId` | `sha256("travel-assistant:" + sub)` | one conversation | short-term events |
| `actorId` | `u-` + `sha256("travel-assistant-actor:" + sub)` | one person | long-term records |

Today both are stable per user, so they identify the same thing and the split looks like
ceremony. It is not. The preference namespace is `/preferences/{actorId}`, so the day a
real per-conversation session id arrives — a hosted-UI client, or simply a "new chat"
button — everything the agent has learned stays put instead of being orphaned with the
conversation that taught it. Making that change later, after records exist under
session-shaped namespaces, would mean a migration; making it now costs one hash.

The two values are deliberately **different strings** rather than one value used twice,
so that a log line naming one can never be mistaken for the other.

`actorId` travels from the BFF to the Runtime in the invocation payload, alongside
`scopes`. That channel is server-to-server: only the BFF holds `InvokeAgentRuntime` and
the Runtime has no public endpoint, so it carries exactly the trust the scope list
already does. A client that puts `actorId` in its own request body is attempting to read
another person's long-term memory — the field is never read, and the attempt is recorded
as a `blocked` span for the same reason `sessionId` already was.

## Decision 2 — we store the turn's text, not the model's message array

The tempting implementation is to persist the full Converse `Message[]`, tool blocks and
all, and replay it verbatim. We store only the user's question and the final answer,
as one `conversational` event with two payload entries.

Three reasons, in order of how much they would have cost us:

1. **`toolUseId` pairing is exact and unforgiving.** A replayed `toolUse` block with no
   matching `toolResult` — or the reverse — makes Converse reject the whole turn. One
   malformed stored event would then break *every later turn in that session*, permanently.
2. **The extraction strategies read `conversational` payloads.** Tool call traffic is
   noise to them: they would be asked to infer travel preferences from geocoding results.
3. **Replayed history is billed as input tokens on every subsequent turn.** Tool results
   are the bulk of a turn and the least reusable part of it.

The same reasoning caps history at **10 turns** (`MAX_HISTORY_TURNS`). Uncapped, the cost
of a conversation grows with its length — the one shape of runaway spend that a
per-request throttle cannot see, because every individual request stays legal.

We defend against malformed history rather than trusting it: `alternating()` drops any
message that breaks the strict user/assistant order Converse requires, including a
trailing unanswered question. Losing a line of history beats losing the session.

## Decision 3 — USER_PREFERENCE, not SEMANTIC or SUMMARY

One strategy, and the cheapest useful one. What is worth carrying between conversations
is what this traveller likes — not a precis of what was said. A `SUMMARY` strategy would
pay a model to re-store forecasts that `get_weather` fetches for free and fresher, which
is the same mistake the roadmap already rejected for `get_place_details`.

Preferences are rendered into the system prompt **labelled as possibly stale**, with an
explicit rule that the current message wins. They were extracted by a model from earlier
turns, not stated by the user in this one; handed over unlabelled they would be
indistinguishable from something just said. This is the same principle as `mock: true` on
a mocked tool result — a claim of a different provenance has to say so.

## Decision 4 — memory failure degrades the agent, it does not break it

Recall is loaded concurrently and every memory call is failure-tolerant: a store that
times out yields empty history and empty preferences, and a failed write does not turn a
successful answer into a 500. The `error` span is still emitted, so a silently forgetful
agent is visible in CloudWatch rather than merely quiet.

The write is **awaited**, not fired and forgotten. AgentCore may stop the container as
soon as the response is written, and a detached promise there is a turn that never
happened.

## What the first cloud run changed

Two details of decision 3 were wrong until the deployed strategy produced real records:

- The record is a serialised JSON object, not a sentence. `preferenceText()` now takes
  the `preference` field and leaves `context` and `categories` behind.
- Extraction latency is minutes, and `list-memory-extraction-jobs` never shows the
  strategy's own runs — so there is no API that says "extraction is working", only the
  records themselves. Verify by reading the namespace, never by reading a job list.

## Consequences

- Three extra data-plane calls per turn (`ListEvents`, `RetrieveMemoryRecords`,
  `CreateEvent`), two of them on the critical path and run in parallel.
- **Per-turn cost rises**, mostly from replayed history rather than from Memory itself.
  A long conversation roughly doubles input tokens, so the 100 requests/day quota now
  caps the worst case nearer 2 USD/day than 1. Still a fifth of the account cap.
- Long-term extraction runs a model on AWS's schedule under `MemoryRole`. That policy is
  deliberately wider than the runtime's model policy: AWS chooses the extraction model,
  and pinning it to our one inference profile would break silently — as a strategy that
  quietly stops producing records — the day that choice changes.
- `guard.ts` is untouched. Scopes gate tools; memory is not a tool.
