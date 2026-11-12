import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import {
  fiscalNoteCancelSchema,
  fiscalNoteCreateSchema,
  fiscalPeriodQuerySchema,
  formatCentsPlain,
  formatIsoDateBR,
} from '@yudirect/contracts';
import { csvCell, toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { renderPaymentReceipt } from '../../pdf/payment-receipt.js';
import { cancelFiscalNote, createFiscalNote, listFiscalNotes, paymentReceiptData, pendingFiscalPayments } from '../../services/fiscal.js';

const BOM = String.fromCharCode(0xfeff);
const idParam = (request: FastifyRequest): ObjectId => toObjectId((request.params as { id: string }).id);
const actorOf = (request: FastifyRequest) => {
  const auth = requireAuthContext(request);
  return { organizationId: auth.organizationId, userId: auth.userId };
};

/** Recibos e controle de notas de serviço herdam as permissões do Financeiro. */
export async function registerFiscalRoutes(app: FastifyInstance): Promise<void> {
  const read = { onRequest: [app.requireAuth, app.requirePermission('finance', 'read')] };
  const write = { onRequest: [app.requireAuth, app.requirePermission('finance', 'create')] };

  app.get('/payments/:id/receipt.pdf', read, async (request, reply) => {
    const actor = actorOf(request);
    const pdf = await renderPaymentReceipt(await paymentReceiptData(request.appCtx, actor.organizationId, idParam(request)));
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="recibo-${idParam(request).toHexString().slice(-8)}.pdf"`)
      .header('cache-control', 'no-store')
      .send(pdf);
  });

  app.get('/fiscal/pending', read, async (request) => {
    const { organizationId } = requireAuthContext(request);
    const { from, to } = fiscalPeriodQuerySchema.parse(request.query);
    const data = await pendingFiscalPayments(request.appCtx, organizationId, from, to);
    return { data, totalCents: data.reduce((sum, p) => sum + p.amountCents, 0) };
  });

  /** Lista para o contador: recebimentos de serviço sem nota. */
  app.get('/fiscal/pending.csv', read, async (request, reply) => {
    const { organizationId } = requireAuthContext(request);
    const { from, to } = fiscalPeriodQuerySchema.parse(request.query);
    const rows = await pendingFiscalPayments(request.appCtx, organizationId, from, to);
    const lines = [
      ['Data do pagamento', 'Motorista', 'Descrição', 'Forma de pagamento', 'Valor'].map(csvCell).join(';'),
      ...rows.map((r) => [formatIsoDateBR(r.paidAt), r.driverName ?? '', r.description, r.method, formatCentsPlain(r.amountCents)].map(csvCell).join(';')),
    ];
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="recebimentos-sem-nota.csv"')
      .header('cache-control', 'no-store')
      .send(`${BOM}${lines.join('\r\n')}\r\n`);
  });

  app.get('/fiscal/notes', read, async (request) => {
    const { organizationId } = requireAuthContext(request);
    const { from, to } = fiscalPeriodQuerySchema.parse(request.query);
    return { data: await listFiscalNotes(request.appCtx, organizationId, from, to) };
  });

  app.post('/fiscal/notes', write, async (request, reply) => {
    const actor = actorOf(request);
    const doc = await createFiscalNote(request.appCtx, actor, fiscalNoteCreateSchema.parse(request.body));
    reply.status(201);
    return (await listFiscalNotes(request.appCtx, actor.organizationId)).find((n) => n.id === doc._id.toHexString());
  });

  app.post('/fiscal/notes/:id/cancel', write, async (request) => {
    const actor = actorOf(request);
    const { reason } = fiscalNoteCancelSchema.parse(request.body);
    const doc = await cancelFiscalNote(request.appCtx, actor, idParam(request), reason);
    return (await listFiscalNotes(request.appCtx, actor.organizationId)).find((n) => n.id === doc._id.toHexString());
  });
}
