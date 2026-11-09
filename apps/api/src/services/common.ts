import { ObjectId, type ClientSession } from 'mongodb';
import type { AppContext } from '../context.js';
import { formatSequence } from '../common/helpers.js';

/** Sequência atômica por organização/escopo/ano (OS, contratos). */
export async function nextSequence(
  ctx: AppContext,
  organizationId: ObjectId,
  scope: string,
  year: number,
  session?: ClientSession,
): Promise<number> {
  const _id = `${organizationId.toHexString()}:${scope}:${year}`;
  const result = await ctx.mongo.collections.counters.findOneAndUpdate(
    { _id },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session },
  );
  return result?.seq ?? 1;
}

export async function nextNumber(
  ctx: AppContext,
  organizationId: ObjectId,
  scope: string,
  prefix: string,
  year: number,
  session?: ClientSession,
): Promise<{ number: string; sequence: number }> {
  const sequence = await nextSequence(ctx, organizationId, scope, year, session);
  return { number: formatSequence(prefix, year, sequence), sequence };
}

/** Trilha de auditoria para ações críticas (exclusões, pagamentos, OS). */
export async function audit(
  ctx: AppContext,
  params: {
    organizationId: ObjectId;
    actorId: ObjectId | null;
    action: string;
    entityType: string;
    entityId: ObjectId | null;
    before?: unknown;
    after?: unknown;
    correlationId?: string | null;
  },
  session?: ClientSession,
): Promise<void> {
  await ctx.mongo.collections.auditLogs.insertOne(
    {
      _id: new ObjectId(),
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      before: redact(params.before),
      after: redact(params.after),
      correlationId: params.correlationId ?? null,
      occurredAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    { session },
  );
}

const SENSITIVE_KEYS = new Set([
  'passwordHash',
  'password',
  'cpfEncrypted',
  'rgEncrypted',
  'cpfLookupHash',
  'tokenHash',
  'requestTokenHash',
]);

/** Remove PII/segredos antes de persistir no log de auditoria. */
export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Date || value instanceof ObjectId) return value;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}
