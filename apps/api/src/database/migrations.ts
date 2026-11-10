import type { AppContext } from '../context.js';
import { withLease } from '../jobs/lease.js';
import { backfillRentalPaymentEntries } from '../services/rental-payments.js';

/* ------------------------------------------------------------------ *
 * Migrações de DADOS (o esquema é aditivo e os índices são criados por
 * ensureIndexes). Cada migração roda uma única vez por banco, registrada
 * na coleção `migrations`, sob lease — várias dynos subindo ao mesmo
 * tempo não executam duas vezes. Toda migração deve ser idempotente.
 * ------------------------------------------------------------------ */

export interface Migration {
  id: string;
  description: string;
  run: (ctx: AppContext) => Promise<Record<string, number>>;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '2026-11-10-payments-reversed',
    description: 'Marca pagamentos cujo lançamento bancário já foi estornado (saem da DRE e dos relatórios).',
    async run(ctx) {
      const c = ctx.mongo.collections;
      let marked = 0;
      const cursor = c.payments.find({ reversedAt: null, transactionId: { $ne: null } });
      for await (const payment of cursor) {
        const tx = await c.bankTransactions.findOne({ _id: payment.transactionId!, organizationId: payment.organizationId });
        if (!tx?.reversedByTransactionId) continue;
        const reversal = await c.bankTransactions.findOne({ _id: tx.reversedByTransactionId });
        const res = await c.payments.updateOne(
          { _id: payment._id, reversedAt: null },
          { $set: { reversedAt: reversal?.createdAt ?? new Date(), reversalTransactionId: tx.reversedByTransactionId } },
        );
        marked += res.modifiedCount;
      }
      return { marked };
    },
  },
  {
    id: '2026-11-10-rental-payment-entries',
    description:
      'Cria lançamentos (aba Pagamentos da locação, com recibo INV) para os recebimentos de locação que já existiam.',
    async run(ctx) {
      return backfillRentalPaymentEntries(ctx);
    },
  },
];

interface MigrationDoc {
  _id: string;
  appliedAt: Date;
  result: Record<string, number>;
}

export async function runMigrations(
  ctx: AppContext,
  log: (msg: string, data?: unknown) => void = () => undefined,
  migrations: Migration[] = MIGRATIONS,
): Promise<string[]> {
  const col = ctx.mongo.db.collection<MigrationDoc>('migrations');
  const applied: string[] = [];
  const outcome = await withLease(ctx, 'migrations', 10 * 60 * 1000, async () => {
    for (const m of migrations) {
      if (await col.findOne({ _id: m.id })) continue;
      const result = await m.run(ctx);
      await col.insertOne({ _id: m.id, appliedAt: new Date(), result });
      applied.push(m.id);
      log(`migração aplicada: ${m.id}`, result);
    }
  });
  if (!outcome.ran) log('migrações: outra instância está executando');
  return applied;
}
