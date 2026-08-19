/**
 * Log structure from the diagram: Session -> trace -> span.
 *
 * Session = one user's conversation (sessionId mapped server-side from the JWT).
 * trace   = one turn (user message -> final agent answer).
 * span    = a single step within a turn (model call, tool call, interceptor block).
 *
 * Emitted as JSON Lines on **stderr**, not stdout. Two reasons, and the first one is
 * empirical: the AgentCore Runtime log group captured stderr and dropped stdout, so
 * spans written with console.log reached CloudWatch nowhere. The second is consistency —
 * `local.ts` keeps stdout for the agent's answer so a caller can pipe it, which makes
 * stderr the correct channel for diagnostics anyway.
 */

export type SpanStatus = 'ok' | 'error' | 'blocked';

export interface SpanRecord {
  type: 'span';
  sessionId: string;
  traceId: string;
  spanId: string;
  name: string;
  status: SpanStatus;
  durationMs: number;
  attributes: Record<string, unknown>;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${(++counter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export class Trace {
  readonly traceId = nextId('trace');

  constructor(
    readonly sessionId: string,
    private readonly emit: (record: SpanRecord) => void = defaultEmit,
  ) {}

  /**
   * Wraps an agent step in a span. An exception is logged with status `error`
   * and rethrown — a span never swallows a failure.
   */
  async span<T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await fn();
      this.record(name, 'ok', startedAt, attributes);
      return result;
    } catch (err) {
      this.record(name, 'error', startedAt, {
        ...attributes,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** A span with no execution — for events whose whole point is that nothing happened. */
  blocked(name: string, attributes: Record<string, unknown>): void {
    this.record(name, 'blocked', Date.now(), attributes);
  }

  private record(name: string, status: SpanStatus, startedAt: number, attributes: Record<string, unknown>): void {
    this.emit({
      type: 'span',
      sessionId: this.sessionId,
      traceId: this.traceId,
      spanId: nextId('span'),
      name,
      status,
      durationMs: Date.now() - startedAt,
      attributes,
    });
  }
}

function defaultEmit(record: SpanRecord): void {
  console.error(JSON.stringify(record));
}
