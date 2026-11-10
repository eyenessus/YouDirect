import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context.js';

/* ------------------------------------------------------------------ *
 * Trava distribuída por lease no MongoDB (plano §7).
 *
 * Garante que um job periódico rode em no máximo uma instância por vez,
 * mesmo com várias dynos ou com execução mais longa que o intervalo. Se
 * o processo morrer, o lease expira sozinho e outra instância assume.
 * Isto é proteção de concorrência — a idempotência dos efeitos continua
 * garantida por índices únicos.
 * ------------------------------------------------------------------ */

const instanceId = `${process.pid}-${randomUUID().slice(0, 8)}`;

export async function tryAcquireLease(
  ctx: AppContext,
  jobName: string,
  ttlMs: number,
  owner = instanceId,
): Promise<boolean> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + ttlMs);
  try {
    const res = await ctx.mongo.collections.jobLeases.findOneAndUpdate(
      { _id: jobName, $or: [{ leaseUntil: { $lte: now } }, { owner }] },
      { $set: { owner, leaseUntil } },
      { upsert: true, returnDocument: 'after' },
    );
    return res?.owner === owner;
  } catch (err) {
    // Upsert concorrente: outra instância criou o documento primeiro.
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

export async function releaseLease(ctx: AppContext, jobName: string, owner = instanceId): Promise<void> {
  await ctx.mongo.collections.jobLeases.updateOne(
    { _id: jobName, owner },
    { $set: { owner: null, leaseUntil: new Date(0), lastRunAt: new Date() } },
  );
}

/**
 * Executa `fn` somente se conseguir o lease. Retorna `{ ran: false }`
 * quando outra instância já está executando o mesmo job.
 */
export async function withLease<T>(
  ctx: AppContext,
  jobName: string,
  ttlMs: number,
  fn: () => Promise<T>,
  owner = instanceId,
): Promise<{ ran: true; result: T } | { ran: false }> {
  if (!(await tryAcquireLease(ctx, jobName, ttlMs, owner))) return { ran: false };
  try {
    return { ran: true, result: await fn() };
  } finally {
    await releaseLease(ctx, jobName, owner);
  }
}
