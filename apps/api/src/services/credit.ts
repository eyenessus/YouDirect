import { ObjectId } from 'mongodb';
import {
  countsAsBillable,
  creditMonth,
  creditReportSchema,
  defaultCreditSettings,
  isValidCpf,
  type CreditCheck,
  type CreditCheckRequest,
  type CreditCheckResult,
  type CreditCheckStatus,
  type CreditIntegrationStatus,
  type CreditReport,
  type CreditReviewInput,
  type CreditSettings,
  type CreditUsageReport,
  type CreditUsageRow,
} from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import type { CreditCheckDoc, OrganizationDoc } from '../database/types.js';
import { piiPepper } from '../config/env.js';
import { lookupHash } from '../common/helpers.js';
import { conflict, integrationUnavailable, notFound, unprocessable } from '../common/errors.js';
import type { SerasaOutcome } from '../integrations/serasa.js';
import { audit } from './common.js';

/* ------------------------------------------------------------------ *
 * Análise de crédito do motorista (Serasa).
 *
 * Ordem de proteção do custo: idempotência do clique → reaproveitamento
 * dentro da validade → limite mensal → uma consulta em andamento por
 * motorista (índice único) → chamada. Nada aqui decide a locação: o
 * resultado é apresentado e a decisão é registrada por uma pessoa.
 * ------------------------------------------------------------------ */

const DAY = 86_400_000;
/** Consulta "em andamento" há mais que isso virou incerta (processo caiu no meio). */
const STALE_PENDING_MS = 10 * 60_000;

export function creditSettingsOf(settings: OrganizationDoc['settings'] | undefined): CreditSettings {
  return { ...defaultCreditSettings, ...(settings?.credit ?? {}) };
}

function decryptReport(ctx: AppContext, doc: CreditCheckDoc): CreditReport | null {
  if (!doc.reportEncrypted) return null;
  const plain = ctx.pii.decrypt(doc.reportEncrypted);
  if (!plain) return null;
  const parsed = creditReportSchema.safeParse(JSON.parse(plain));
  return parsed.success ? parsed.data : null;
}

export async function toCreditCheckDTOs(
  ctx: AppContext,
  docs: CreditCheckDoc[],
  opts: { includeReport: boolean },
): Promise<CreditCheck[]> {
  const userIds = [...new Set(docs.flatMap((d) => [d.requestedBy, d.review?.reviewedBy]).filter((v): v is ObjectId => Boolean(v)).map(String))];
  const driverIds = [...new Set(docs.map((d) => String(d.driverId)))];
  const [users, drivers] = await Promise.all([
    userIds.length ? ctx.mongo.collections.users.find({ _id: { $in: userIds.map((id) => new ObjectId(id)) } }, { projection: { name: 1 } }).toArray() : [],
    driverIds.length
      ? ctx.mongo.collections.drivers.find({ _id: { $in: driverIds.map((id) => new ObjectId(id)) } }, { projection: { fullName: 1 } }).toArray()
      : [],
  ]);
  const userName = new Map(users.map((u) => [String(u._id), u.name]));
  const driverName = new Map(drivers.map((d) => [String(d._id), d.fullName]));
  return docs.map((d) => ({
    id: d._id.toHexString(),
    driverId: d.driverId.toHexString(),
    driverName: driverName.get(String(d.driverId)) ?? null,
    rentalId: d.rentalId?.toHexString() ?? null,
    purpose: d.purpose,
    justification: d.justification,
    status: d.status,
    outcome: d.outcome,
    message: d.message,
    environment: d.environment,
    reportName: d.reportName,
    billable: d.billable,
    estimatedCostCents: d.estimatedCostCents,
    requestedBy: { id: d.requestedBy.toHexString(), name: userName.get(String(d.requestedBy)) ?? 'Usuário removido' },
    requestedAt: d.requestedAt.toISOString(),
    completedAt: d.completedAt?.toISOString() ?? null,
    report: opts.includeReport ? decryptReport(ctx, d) : null,
    reportExpiresAt: d.reportEncrypted ? (d.reportExpiresAt?.toISOString() ?? null) : null,
    reportPurged: Boolean(d.reportPurgedAt),
    review: d.review
      ? {
          decision: d.review.decision,
          notes: d.review.notes,
          reviewedBy: userName.get(String(d.review.reviewedBy)) ?? 'Usuário removido',
          reviewedAt: d.review.reviewedAt.toISOString(),
        }
      : null,
  }));
}

function monthRange(now: Date): { start: Date; end: Date } {
  // Mês civil de São Paulo (UTC-3, sem horário de verão desde 2019).
  const [y, m] = creditMonth(now).split('-').map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1, 3)), end: new Date(Date.UTC(y, m, 1, 3)) };
}

const BILLABLE_FILTER = { status: { $in: ['PENDING', 'COMPLETED', 'NOT_AVAILABLE', 'UNCERTAIN'] as CreditCheckStatus[] }, billable: { $ne: 'NO' as const } };

export async function billableThisMonth(ctx: AppContext, organizationId: ObjectId, now = new Date()): Promise<number> {
  const { start, end } = monthRange(now);
  return ctx.mongo.collections.creditChecks.countDocuments({ organizationId, requestedAt: { $gte: start, $lt: end }, ...BILLABLE_FILTER });
}

export async function creditIntegrationStatus(ctx: AppContext, organizationId: ObjectId): Promise<CreditIntegrationStatus> {
  const org = await ctx.mongo.collections.organizations.findOne({ _id: organizationId }, { projection: { settings: 1 } });
  const settings = creditSettingsOf(org?.settings);
  const provider = ctx.integrations.credit;
  const status = provider.status();
  const now = new Date();
  const { start, end } = monthRange(now);
  const [billable, uncertain] = await Promise.all([
    billableThisMonth(ctx, organizationId, now),
    ctx.mongo.collections.creditChecks.countDocuments({ organizationId, requestedAt: { $gte: start, $lt: end }, status: 'UNCERTAIN' }),
  ]);
  const product = provider.product();
  return {
    connected: status.connected,
    environment: provider.environment(),
    message: status.message,
    reportName: product.reportName,
    optionalFeatures: product.optionalFeatures,
    scoreModel: product.scoreModel,
    settings,
    usage: {
      month: creditMonth(now),
      billable,
      uncertain,
      estimatedCostCents: settings.costPerQueryCents === null ? null : billable * settings.costPerQueryCents,
      limit: settings.monthlyLimit,
    },
  };
}

function applyOutcome(outcome: SerasaOutcome): Pick<CreditCheckDoc, 'status' | 'outcome' | 'message' | 'httpStatus' | 'providerCode' | 'billable'> & {
  report: CreditReport | null;
} {
  switch (outcome.kind) {
    case 'REPORT':
      return { status: 'COMPLETED', outcome: 'REPORT', message: null, httpStatus: outcome.httpStatus, providerCode: null, billable: 'YES', report: outcome.report };
    case 'NOT_AVAILABLE':
      return {
        status: 'NOT_AVAILABLE',
        outcome: 'NOT_AVAILABLE',
        message: `${outcome.message} Isso não indica ausência de risco.`,
        httpStatus: outcome.httpStatus,
        providerCode: outcome.providerCode,
        billable: 'UNKNOWN',
        report: null,
      };
    case 'REJECTED':
      return { status: 'FAILED', outcome: outcome.outcome, message: outcome.message, httpStatus: outcome.httpStatus, providerCode: outcome.providerCode, billable: 'NO', report: null };
    case 'UNCERTAIN':
      return {
        status: 'UNCERTAIN',
        outcome: outcome.outcome,
        message: `${outcome.message} Não repita sem antes conferir o extrato de consumo da Serasa.`,
        httpStatus: outcome.httpStatus,
        providerCode: null,
        billable: 'UNKNOWN',
        report: null,
      };
  }
}

export async function requestCreditCheck(
  ctx: AppContext,
  params: { organizationId: ObjectId; actorId: ObjectId; driverId: ObjectId; body: CreditCheckRequest },
): Promise<CreditCheckResult> {
  const { organizationId, actorId, driverId, body } = params;
  const c = ctx.mongo.collections;
  const one = async (doc: CreditCheckDoc, reused: boolean, includeReport = true): Promise<CreditCheckResult> => ({
    check: (await toCreditCheckDTOs(ctx, [doc], { includeReport }))[0]!,
    reused,
  });

  // 1. Clique repetido: devolve a mesma consulta, sem nova chamada.
  const sameKey = await c.creditChecks.findOne({ organizationId, idempotencyKey: body.idempotencyKey });
  if (sameKey) {
    if (!sameKey.driverId.equals(driverId)) throw conflict('Chave de requisição reutilizada para outro motorista.');
    return one(sameKey, false);
  }

  const org = await c.organizations.findOne({ _id: organizationId }, { projection: { settings: 1 } });
  const settings = creditSettingsOf(org?.settings);
  if (!settings.enabled) throw unprocessable('A análise de crédito está desligada. Um administrador pode ligá-la em Perfil > Serasa.');
  const provider = ctx.integrations.credit;
  if (!provider.status().connected) throw integrationUnavailable(provider.status().message);

  const driver = await c.drivers.findOne({ _id: driverId, organizationId });
  if (!driver || driver.anonymizedAt) throw notFound('Motorista não encontrado.');
  const cpf = ctx.pii.decrypt(driver.cpfEncrypted)?.replace(/\D+/g, '') ?? null;
  if (!cpf) throw unprocessable('Cadastre o CPF do motorista antes de consultar.');
  if (!isValidCpf(cpf)) throw unprocessable('O CPF cadastrado é inválido (dígitos verificadores). Corrija o cadastro antes de consultar.');

  let rentalId: ObjectId | null = null;
  if (body.rentalId) {
    const rental = await c.rentals.findOne({ _id: new ObjectId(body.rentalId), organizationId, driverId }, { projection: { _id: 1 } });
    if (!rental) throw notFound('Locação não encontrada para este motorista.');
    rentalId = rental._id;
  }

  const documentHash = lookupHash(cpf, piiPepper(ctx.env));
  const now = new Date();

  // 2. Reaproveita consulta recente do mesmo CPF (sem nova cobrança).
  if (!body.forceNew && settings.reuseDays > 0) {
    const recent = await c.creditChecks.findOne(
      {
        organizationId,
        driverId,
        documentHash,
        status: 'COMPLETED',
        environment: provider.environment(),
        reportEncrypted: { $type: 'string' },
        requestedAt: { $gte: new Date(now.getTime() - settings.reuseDays * DAY) },
      },
      { sort: { requestedAt: -1 } },
    );
    if (recent) {
      await audit(ctx, {
        organizationId,
        actorId,
        action: 'credit.check_reused',
        entityType: 'creditCheck',
        entityId: recent._id,
        after: { purpose: body.purpose, justification: body.justification },
      });
      return one(recent, true);
    }
  }

  // 3. Limite mensal da organização.
  if (settings.monthlyLimit !== null && (await billableThisMonth(ctx, organizationId, now)) >= settings.monthlyLimit) {
    throw conflict(`Limite mensal de ${settings.monthlyLimit} consultas atingido. Um administrador pode ajustar em Perfil > Serasa.`);
  }

  // 4. Registra a consulta antes de chamar (índice único: uma em andamento por motorista).
  const product = provider.product();
  const doc: CreditCheckDoc = {
    _id: new ObjectId(),
    organizationId,
    driverId,
    rentalId,
    requestedBy: actorId,
    purpose: body.purpose,
    justification: body.justification,
    legalBasis: 'PROTECAO_CREDITO',
    holderInformedAt: now,
    idempotencyKey: body.idempotencyKey,
    documentHash,
    environment: provider.environment(),
    reportName: product.reportName,
    optionalFeatures: product.optionalFeatures,
    status: 'PENDING',
    outcome: null,
    message: null,
    httpStatus: null,
    providerCode: null,
    billable: 'UNKNOWN',
    estimatedCostCents: settings.costPerQueryCents,
    requestedAt: now,
    completedAt: null,
    reportEncrypted: null,
    reportExpiresAt: null,
    reportPurgedAt: null,
    review: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  try {
    await c.creditChecks.insertOne(doc);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const raced = await c.creditChecks.findOne({ organizationId, idempotencyKey: body.idempotencyKey });
      if (raced) return one(raced, false);
      throw conflict('Já existe uma consulta em andamento para este motorista. Aguarde o resultado.');
    }
    throw err;
  }
  await audit(ctx, {
    organizationId,
    actorId,
    action: 'credit.check_requested',
    entityType: 'creditCheck',
    entityId: doc._id,
    after: { driverId, purpose: body.purpose, justification: body.justification, legalBasis: doc.legalBasis, reportName: doc.reportName, environment: doc.environment },
    correlationId: doc._id.toHexString(),
  });

  // 5. Chamada à Serasa (o cliente nunca repete uma consulta possivelmente cobrada).
  const outcome = await provider.fetchReport(cpf);
  const result = applyOutcome(outcome);
  const completedAt = new Date();
  const set: Partial<CreditCheckDoc> = {
    status: result.status,
    outcome: result.outcome,
    message: result.message,
    httpStatus: result.httpStatus,
    providerCode: result.providerCode,
    billable: result.billable,
    estimatedCostCents: result.billable === 'NO' ? 0 : settings.costPerQueryCents,
    completedAt,
    updatedAt: completedAt,
  };
  if (result.report) {
    set.reportEncrypted = ctx.pii.encrypt(JSON.stringify(result.report));
    set.reportExpiresAt = new Date(completedAt.getTime() + settings.retentionDays * DAY);
  }
  // Se esta gravação falhar, a consulta fica PENDING e a rotina a marca como incerta.
  const updated = await c.creditChecks.findOneAndUpdate(
    { _id: doc._id, status: 'PENDING' },
    { $set: set, $inc: { version: 1 } },
    { returnDocument: 'after' },
  );
  await audit(ctx, {
    organizationId,
    actorId,
    action: 'credit.check_completed',
    entityType: 'creditCheck',
    entityId: doc._id,
    after: { status: result.status, outcome: result.outcome, httpStatus: result.httpStatus, providerCode: result.providerCode, billable: result.billable },
    correlationId: doc._id.toHexString(),
  });
  return one(updated ?? { ...doc, ...set }, false);
}

export async function reviewCreditCheck(
  ctx: AppContext,
  params: { organizationId: ObjectId; actorId: ObjectId; checkId: ObjectId; body: CreditReviewInput },
): Promise<CreditCheck> {
  const c = ctx.mongo.collections;
  const doc = await c.creditChecks.findOne({ _id: params.checkId, organizationId: params.organizationId });
  if (!doc) throw notFound('Consulta não encontrada.');
  if (doc.status !== 'COMPLETED' && doc.status !== 'NOT_AVAILABLE') {
    throw conflict('Só é possível registrar a decisão de uma consulta concluída ou sem informação disponível.');
  }
  const review = { decision: params.body.decision, notes: params.body.notes, reviewedBy: params.actorId, reviewedAt: new Date() };
  const updated = await c.creditChecks.findOneAndUpdate(
    { _id: doc._id },
    { $set: { review, updatedAt: new Date() }, $inc: { version: 1 } },
    { returnDocument: 'after' },
  );
  await audit(ctx, {
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: 'credit.check_reviewed',
    entityType: 'creditCheck',
    entityId: doc._id,
    before: doc.review ? { decision: doc.review.decision, notes: doc.review.notes } : null,
    after: { decision: review.decision, notes: review.notes },
  });
  return (await toCreditCheckDTOs(ctx, [updated!], { includeReport: true }))[0]!;
}

export async function creditUsage(ctx: AppContext, organizationId: ObjectId, months = 6, now = new Date()): Promise<CreditUsageReport> {
  const org = await ctx.mongo.collections.organizations.findOne({ _id: organizationId }, { projection: { settings: 1 } });
  const cost = creditSettingsOf(org?.settings).costPerQueryCents;
  const { start: currentStart } = monthRange(now);
  const from = new Date(Date.UTC(currentStart.getUTCFullYear(), currentStart.getUTCMonth() - (months - 1), 1, 3));
  const docs = await ctx.mongo.collections.creditChecks
    .find({ organizationId, requestedAt: { $gte: from } }, { projection: { status: 1, billable: 1, requestedAt: 1, requestedBy: 1 } })
    .toArray();
  const reusedEvents = await ctx.mongo.collections.auditLogs
    .find({ organizationId, action: 'credit.check_reused', occurredAt: { $gte: from } }, { projection: { occurredAt: 1 } })
    .toArray();

  const rows = new Map<string, CreditUsageRow>();
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 15));
    const key = creditMonth(d);
    rows.set(key, { month: key, total: 0, billable: 0, notBilled: 0, uncertain: 0, reused: 0, estimatedCostCents: cost === null ? null : 0 });
  }
  const byUser = new Map<string, number>();
  for (const d of docs) {
    const row = rows.get(creditMonth(d.requestedAt));
    if (!row) continue;
    row.total += 1;
    if (d.billable !== 'NO' && countsAsBillable(d.status)) {
      row.billable += 1;
      if (row.estimatedCostCents !== null && cost !== null) row.estimatedCostCents += cost;
    } else row.notBilled += 1;
    if (d.status === 'UNCERTAIN') row.uncertain += 1;
    byUser.set(String(d.requestedBy), (byUser.get(String(d.requestedBy)) ?? 0) + 1);
  }
  for (const e of reusedEvents) {
    const row = rows.get(creditMonth(e.occurredAt));
    if (row) row.reused += 1;
  }
  const users = byUser.size
    ? await ctx.mongo.collections.users.find({ _id: { $in: [...byUser.keys()].map((id) => new ObjectId(id)) } }, { projection: { name: 1 } }).toArray()
    : [];
  const names = new Map(users.map((u) => [String(u._id), u.name]));
  return {
    months: [...rows.values()].reverse(),
    byUser: [...byUser.entries()]
      .map(([userId, total]) => ({ userId, name: names.get(userId) ?? 'Usuário removido', total }))
      .sort((a, b) => b.total - a.total),
  };
}

/** Retenção: apaga o conteúdo dos relatórios vencidos (fica só o registro da consulta). */
export async function purgeExpiredCreditReports(ctx: AppContext, now = new Date()): Promise<number> {
  const res = await ctx.mongo.collections.creditChecks.updateMany(
    { reportEncrypted: { $type: 'string' }, reportExpiresAt: { $lte: now } },
    { $set: { reportEncrypted: null, reportPurgedAt: now, updatedAt: now } },
  );
  return res.modifiedCount;
}

/** Consulta presa em andamento (processo caiu): vira incerta, sem nova chamada. */
export async function expireStaleCreditChecks(ctx: AppContext, now = new Date()): Promise<number> {
  const res = await ctx.mongo.collections.creditChecks.updateMany(
    { status: 'PENDING', requestedAt: { $lte: new Date(now.getTime() - STALE_PENDING_MS) } },
    {
      $set: {
        status: 'UNCERTAIN',
        outcome: 'INTERRUPTED',
        message: 'A consulta foi interrompida antes de gravar o resultado. Ela pode ter sido cobrada; confira o extrato da Serasa antes de repetir.',
        billable: 'UNKNOWN',
        completedAt: now,
        updatedAt: now,
      },
      $inc: { version: 1 },
    },
  );
  return res.modifiedCount;
}

/** Anonimização do motorista: apaga o conteúdo de todos os relatórios dele. */
export async function purgeDriverCreditReports(ctx: AppContext, organizationId: ObjectId, driverId: ObjectId): Promise<void> {
  const now = new Date();
  await ctx.mongo.collections.creditChecks.updateMany(
    { organizationId, driverId, reportEncrypted: { $type: 'string' } },
    { $set: { reportEncrypted: null, reportPurgedAt: now, updatedAt: now } },
  );
}
