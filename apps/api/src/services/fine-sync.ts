import type { ClientSession, ObjectId } from 'mongodb';
import type { ReceivableStatus } from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import type { ReceivableDoc } from '../database/types.js';

/**
 * Mantém a multa em sincronia com a conta a receber que a cobra:
 * quitada → PAID; estornada (volta a ter saldo) → CHARGED.
 * Chamado na MESMA transação do pagamento/estorno. Fica fora de
 * `traffic-fines.ts` para não criar dependência circular com `finance.ts`.
 */
export async function syncFineFromReceivable(
  ctx: AppContext,
  receivable: Pick<ReceivableDoc, 'kind' | 'trafficFineId' | 'organizationId'>,
  receivableStatus: ReceivableStatus,
  actorId: ObjectId | null,
  session?: ClientSession,
): Promise<void> {
  if (receivable.kind !== 'FINE' || !receivable.trafficFineId) return;
  const now = new Date();
  if (receivableStatus === 'PAID') {
    await ctx.mongo.collections.trafficFines.updateOne(
      { _id: receivable.trafficFineId, organizationId: receivable.organizationId, status: 'CHARGED' },
      {
        $set: { status: 'PAID', updatedAt: now },
        $inc: { version: 1 },
        $push: { history: { at: now, actorId, action: 'paid', detail: null } },
      },
      { session },
    );
  } else if (receivableStatus !== 'CANCELED') {
    await ctx.mongo.collections.trafficFines.updateOne(
      { _id: receivable.trafficFineId, organizationId: receivable.organizationId, status: 'PAID' },
      {
        $set: { status: 'CHARGED', updatedAt: now },
        $inc: { version: 1 },
        $push: { history: { at: now, actorId, action: 'payment_reversed', detail: null } },
      },
      { session },
    );
  }
}
