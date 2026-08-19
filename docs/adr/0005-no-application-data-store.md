# ADR-0005 — The DynamoDB table goes; AgentCore Memory is the only state

Date: 2026-08-19
Status: accepted

## Context

The FigJam diagram draws a DynamoDB table labelled "app data" alongside AgentCore Memory,
and the stack has carried one — `pk`/`sk`, on-demand billing, `RemovalPolicy.DESTROY` —
since the first deploy. Through five ROADMAP steps **no code has ever read from or written
to it.** The runtime role held `grantReadWriteData` and the container held `TABLE_NAME`, for
nothing.

The question is not "is the table useful in general" but "is there state in *this* system
that belongs there". Two kinds of state exist:

- **What the agent should remember about a person** — that they are interested in Lisbon,
  that they check the weather before travelling. AgentCore Memory already stores this, keyed
  on the actor rather than the session, so it outlives any one conversation (ADR-0003).
- **What the agent tells the user** — forecasts, place summaries, photos, flight offers.
  Every one of these is fetched by a tool, and every one is *fresher from the source*. A
  7-day forecast cached in a table is a stale forecast; a Duffel offer cached is an expired
  price.

There is a third, hypothetical kind: saved itineraries — a user asking to keep a plan and
come back to it. That is a real feature, and it is not in this project's scope. No prompt,
tool or endpoint offers it.

## Decision

**Delete the table.** No application data store; AgentCore Memory is the only state the
system keeps.

## Consequences

- The runtime role loses a read/write grant and the container loses an environment
  variable — less to reason about in both.
- One resource fewer in a stack whose whole cost argument is "nothing always-on, nothing
  idle". An on-demand table costs near zero at rest, so this is not a saving; it is
  consistency. We argue every component from Well-Architected, and a component that exists
  because a diagram drew it fails that test on the pillar we said dominates.
- This deviates from the diagram, which is now recorded alongside the other two deviations
  in `CLAUDE.md` (AgentCore Browser replaced by Wikimedia Commons, and `get_place_details`
  reading Wikipedia rather than model knowledge). All three go the same way: drop what adds
  no data.
- If saved itineraries are ever built, the table comes back in the same commit as the code
  that uses it. Re-adding it is ten lines of CDK; deciding what it stores is the hard part,
  and that decision belongs to the feature, not to the infrastructure.

## Rejected: keep it and give it a job

The tempting version is a cache in front of the three keyless APIs. Rejected on two counts.
The tools are called at most a handful of times a day under a 100-requests/day quota, so
there is no load to relieve; and a cache would make the agent's answers *older* while adding
an invalidation problem, which is a strictly worse system defended as an optimisation.

The other version is storing conversation transcripts. That is what AgentCore Memory's
short-term store is, with an expiry we already tuned (`eventExpiryDuration: 7`). Duplicating
it in DynamoDB would mean two sources of truth for the same history and a second place for a
`sessionId` mapping bug to leak one user's conversation into another's.
