/**
 * Local agent run — no AWS beyond Bedrock itself.
 *
 *   npm run dev -- "I'm going to Lisbon this weekend, what's the weather?"
 *   npm run dev -- --scopes=places:read "Show me photos of Lisbon"   # block demo
 */
import { runAgent } from './agent.js';
import { ALL_SCOPES } from './guard.js';

const args = process.argv.slice(2);
const scopeArg = args.find((a) => a.startsWith('--scopes='));
const scopes = scopeArg ? scopeArg.slice('--scopes='.length).split(',') : [...ALL_SCOPES];
const question = args.filter((a) => !a.startsWith('--')).join(' ');

if (!question) {
  console.error('Usage: npm run dev -- [--scopes=a,b] "your question"');
  process.exit(1);
}

const sessionId = `local-${process.env.USER ?? 'dev'}`;
console.error(`\n[session ${sessionId}] scopes: ${scopes.join(', ')}\n`);

const result = await runAgent(question, { sessionId, scopes });

console.error('\n--- answer ---');
console.log(result.answer);
console.error(
  `\n[trace ${result.traceId}] tools: ` +
    (result.toolCalls.map((c) => `${c.name}${c.blocked ? ' (BLOCKED)' : ''}`).join(', ') || 'none'),
);
