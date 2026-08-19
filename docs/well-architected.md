# AWS Well-Architected Framework — the six pillars

The frame for every architectural decision in this project. When adding a component,
walk the list and say which pillar the decision supports and which it hurts —
tradeoffs are normal as long as they are deliberate.

## Operational Excellence
- Run and monitor systems effectively.
- Improve processes continuously.
- Automate changes and share best practices.

## Security
- Protect data, systems, and assets.
- Manage user permissions and access.
- Detect and react to security events quickly.

## Reliability
- Make systems recover from failures automatically.
- Scale horizontally to deal with workload changes.
- Test recovery procedures before real issues happen.

## Performance Efficiency
- Use computing resources in a smart way.
- Keep up with changing demand and new technology.
- Select the right resource types and sizes for your needs.

## Cost Optimization
- Run systems at the lowest possible price point.
- Avoid unneeded or idle resources.
- Track and measure total spending over time.

## Sustainability
- Focus on the long-term environmental impact.
- Reduce resource waste and maximize usage efficiency.
- Choose energy-efficient hardware and cloud regions.

---

## How this project applies them

| Pillar | Tension in this project |
|---|---|
| Cost Optimization | dominant — the 10 USD cap forces `cdk destroy` and drove AgentCore Browser out of the design |
| Security | JWT authorizer, per-tool scopes, server-side user→sessionId mapping |
| Operational Excellence | AgentCore Observability plus ADRs as the record of decisions |
| Reliability | deliberately skipped (no multi-AZ, no retry policy) — this is a learning project |
| Performance Efficiency | picking the cheapest sufficient model (Haiku 4.5) over the largest by default |
| Sustainability | follows from Cost Optimization — we keep no idle resources |
