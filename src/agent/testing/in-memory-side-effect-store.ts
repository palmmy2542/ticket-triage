/**
 * In-memory SideEffectStore for unit tests.
 *
 * Mirrors the semantics the Postgres implementation must provide:
 *  - uniqueness on (conversation, tool, dedupKey)
 *  - a single claim wins; concurrent claimers are told `in_flight`
 *  - a succeeded effect replays instead of re-executing
 *  - a failed effect may be re-claimed (transient failures should be retryable;
 *    the tool's own idempotency key prevents a double execution if the first
 *    attempt actually landed downstream)
 *
 * Keeping this in the repo, next to the port, is deliberate: if the database
 * implementation drifts from these semantics, the shared contract test catches it.
 */
import { randomUUID } from 'node:crypto';

import type { SideEffectRecord, SideEffectStatus, SideEffectStore } from '../types';

interface Row extends SideEffectRecord {
  conversationId: string;
}

export class InMemorySideEffectStore implements SideEffectStore {
  private readonly rows = new Map<string, Row>();

  private key(conversationId: string, toolName: string, dedupKey: string): string {
    return `${conversationId}|${toolName}|${dedupKey}`;
  }

  async requestApproval(input: {
    conversationId: string;
    toolName: string;
    dedupKey: string;
    args: unknown;
  }): Promise<SideEffectRecord> {
    const key = this.key(input.conversationId, input.toolName, input.dedupKey);
    const existing = this.rows.get(key);
    if (existing) return { ...existing };

    const row: Row = {
      id: randomUUID(),
      conversationId: input.conversationId,
      toolName: input.toolName,
      dedupKey: input.dedupKey,
      status: 'pending_approval',
      args: input.args,
    };
    this.rows.set(key, row);
    return { ...row };
  }

  async beginAutonomous(input: {
    conversationId: string;
    toolName: string;
    dedupKey: string;
    args: unknown;
  }): Promise<{ outcome: 'claimed' | 'replayed' | 'in_flight'; record: SideEffectRecord }> {
    const key = this.key(input.conversationId, input.toolName, input.dedupKey);
    const existing = this.rows.get(key);

    if (!existing) {
      const row: Row = {
        id: randomUUID(),
        conversationId: input.conversationId,
        toolName: input.toolName,
        dedupKey: input.dedupKey,
        status: 'executing',
        args: input.args,
      };
      this.rows.set(key, row);
      return { outcome: 'claimed', record: { ...row } };
    }

    if (existing.status === 'succeeded') return { outcome: 'replayed', record: { ...existing } };
    if (existing.status === 'failed') {
      existing.status = 'executing';
      return { outcome: 'claimed', record: { ...existing } };
    }
    return { outcome: 'in_flight', record: { ...existing } };
  }

  async complete(input: {
    id: string;
    status: 'succeeded' | 'failed';
    result: unknown;
  }): Promise<SideEffectRecord> {
    const row = [...this.rows.values()].find((r) => r.id === input.id);
    if (!row) throw new Error(`No side effect ${input.id}`);
    row.status = input.status;
    row.result = input.result;
    return { ...row };
  }

  // --- test helpers ---------------------------------------------------------

  all(): SideEffectRecord[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  byTool(toolName: string): SideEffectRecord[] {
    return this.all().filter((row) => row.toolName === toolName);
  }

  withStatus(status: SideEffectStatus): SideEffectRecord[] {
    return this.all().filter((row) => row.status === status);
  }
}

/** Logger that records events so tests can assert on the audit trail. */
export class RecordingLogger {
  readonly events: Array<{ level: string; obj: Record<string, unknown>; msg?: string }> = [];

  private push(level: string) {
    return (obj: object, msg?: string) =>
      void this.events.push({ level, obj: obj as Record<string, unknown>, msg });
  }

  debug = this.push('debug');
  info = this.push('info');
  warn = this.push('warn');
  error = this.push('error');

  eventNames(): string[] {
    return this.events.map((e) => String(e.obj['event'] ?? ''));
  }

  find(event: string): Record<string, unknown> | undefined {
    return this.events.find((e) => e.obj['event'] === event)?.obj;
  }
}
