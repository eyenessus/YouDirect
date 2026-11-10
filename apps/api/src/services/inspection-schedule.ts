import { ObjectId } from 'mongodb';
import {
  addDaysIso,
  diffDaysIso,
  inspectionWeekdayIndex,
  type InspectionPeriod,
  type InspectionWeekday,
} from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import type { DriverDoc, InspectionDoc, OrganizationDoc, RentalDoc } from '../database/types.js';
import { generateToken, sha256 } from '../common/helpers.js';
import { audit } from './common.js';
import { createNotification } from './notifications.js';
import {
  formatDateTimeLocal,
  getWhatsappSettings,
  newCollection,
  planCollection,
  requiredSlotsSnapshot,
  type CollectionPlan,
} from './whatsapp-inspection.js';

/* ------------------------------------------------------------------ *
 * Vistorias recorrentes geradas pela regra da locação.
 *
 * A locação guarda `inspectionRule = { period, weekday }`:
 *   WEEKLY  → a cada 7 dias a partir do início da locação
 *   MONTHLY → a cada 30 dias (rótulo da interface: "a cada 30 dias")
 *   weekday → quando definido, a ocorrência vai para o PRÓXIMO dia da
 *             semana escolhido a partir da data-base (nunca antes dela).
 *
 * Garantias:
 *  - idempotente: índice único (organização, locação, data) para vistorias
 *    `source: 'SCHEDULED'` — o job pode rodar N vezes, em N instâncias;
 *  - não gera atrasados: só cria ocorrências na janela [hoje, hoje+LEAD];
 *  - uma vistoria gerada e depois cancelada NÃO é recriada (o índice
 *    continua ocupando a data);
 *  - não empilha: se já existe vistoria aberta da locação perto da data
 *    (manual ou gerada), não cria outra.
 * ------------------------------------------------------------------ */

/** Antecedência com que a vistoria é criada (o disparo segue o horário configurado). */
export const SCHEDULE_LEAD_DAYS = 2;
/** Janela em torno da data em que uma vistoria aberta já "cobre" a ocorrência. */
export const OPEN_INSPECTION_TOLERANCE_DAYS = 3;
const MAX_OCCURRENCES_SCAN = 600;

export function periodDays(period: InspectionPeriod): number {
  return period === 'WEEKLY' ? 7 : 30;
}

function weekdayOf(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Primeira data >= `base` que cai no dia da semana pedido. */
export function alignToWeekday(base: string, weekday: InspectionWeekday): string {
  if (weekday === 'ANY') return base;
  const target = inspectionWeekdayIndex[weekday];
  const delta = (target - weekdayOf(base) + 7) % 7;
  return addDaysIso(base, delta);
}

/**
 * Ocorrências da regra entre `from` e `to` (inclusive), ancoradas no
 * início da locação. A primeira ocorrência é um período DEPOIS do início
 * (a vistoria de entrega é feita na retirada do veículo).
 */
export function occurrencesBetween(
  rule: { period: InspectionPeriod | null; weekday: InspectionWeekday },
  startDate: string,
  from: string,
  to: string,
  endDate: string | null = null,
): string[] {
  if (!rule.period) return [];
  const step = periodDays(rule.period);
  const out: string[] = [];
  // Pula direto para perto de `from` (sem iterar desde o início).
  const elapsed = Math.max(0, diffDaysIso(from, startDate));
  let k = Math.max(1, Math.floor(elapsed / step) - 1);
  for (let i = 0; i < MAX_OCCURRENCES_SCAN; i += 1, k += 1) {
    const date = alignToWeekday(addDaysIso(startDate, k * step), rule.weekday);
    if (endDate && date > endDate) break;
    if (date > to) break;
    if (date >= from && !out.includes(date)) out.push(date);
  }
  return out;
}

/** Próxima ocorrência a partir de `today` (para os cartões do painel). */
export function nextOccurrence(
  rule: { period: InspectionPeriod | null; weekday: InspectionWeekday },
  startDate: string,
  today: string,
  endDate: string | null = null,
): string | null {
  if (!rule.period) return null;
  return occurrencesBetween(rule, startDate, today, addDaysIso(today, periodDays(rule.period) + 7), endDate)[0] ?? null;
}

/* ------------------------- montagem do documento ------------------- */

export interface BuildInspectionInput {
  organization: OrganizationDoc | null;
  organizationId: ObjectId;
  vehicleId: ObjectId;
  rental: RentalDoc | null;
  driver: DriverDoc | null;
  responsibleName: string;
  phone: string;
  email: string | null;
  scheduledAt: string;
  notes: string | null;
  source: 'MANUAL' | 'SCHEDULED';
  createdBy: ObjectId | null;
}

/** Monta a vistoria (token do link público, plano de coleta, snapshot dos ângulos). */
export async function buildInspectionDoc(
  ctx: AppContext,
  input: BuildInspectionInput,
): Promise<{ doc: InspectionDoc; token: string; link: string; plan: CollectionPlan }> {
  const plan = planCollection(ctx, {
    organization: input.organization,
    driver: input.driver,
    phone: input.phone,
    scheduledAt: input.scheduledAt,
  });
  const token = generateToken(24);
  const now = new Date();
  const doc: InspectionDoc = {
    _id: new ObjectId(),
    organizationId: input.organizationId,
    vehicleId: input.vehicleId,
    rentalId: input.rental?._id ?? null,
    driverId: input.rental?.driverId ?? null,
    responsibleName: input.responsibleName,
    phone: input.phone,
    email: input.email,
    scheduledAt: input.scheduledAt,
    dueDate: addDaysIso(input.scheduledAt, 2),
    submittedAt: null,
    reviewedAt: null,
    reviewerId: null,
    status: 'PENDING',
    odometerKm: null,
    photos: [],
    notes: input.notes,
    requestTokenHash: sha256(token),
    requestTokenEnc: ctx.pii.encrypt(token),
    requestExpiresAt: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
    delivery: null,
    source: input.source,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    version: 0,
    scheduledSendAt: plan.scheduledSendAt,
    collection:
      plan.status === 'NOT_SCHEDULED'
        ? null
        : newCollection(plan, await requiredSlotsSnapshot(ctx, input.organizationId, getWhatsappSettings(input.organization))),
    photoEvidence: [],
    correctionRound: 0,
  };
  const link = `${ctx.env.APP_URL.replace(/\/$/, '')}/vistoria/${token}`;
  return { doc, token, link, plan };
}

/* ------------------------------ gerador ---------------------------- */

export interface GenerationResult {
  created: number;
  skippedOpen: number;
  existing: number;
}

/**
 * Cria as vistorias recorrentes cuja data cai na janela [hoje, hoje+LEAD].
 * Coleta pelo WhatsApp quando o motorista tem consentimento (o disparo
 * acontece no horário configurado); caso contrário, a vistoria fica com o
 * link manual e a equipe é avisada — nada é enviado sem canal.
 */
export async function generateScheduledInspections(
  ctx: AppContext,
  organizationId: ObjectId,
  today: string,
): Promise<GenerationResult> {
  const c = ctx.mongo.collections;
  const result: GenerationResult = { created: 0, skippedOpen: 0, existing: 0 };
  const rentals = await c.rentals
    .find({ organizationId, status: 'ACTIVE', 'inspectionRule.period': { $in: ['WEEKLY', 'MONTHLY'] } })
    .toArray();
  if (rentals.length === 0) return result;
  const organization = await c.organizations.findOne({ _id: organizationId });
  const windowEnd = addDaysIso(today, SCHEDULE_LEAD_DAYS);

  for (const rental of rentals) {
    const dates = occurrencesBetween(rental.inspectionRule, rental.startDate, today, windowEnd, rental.endDate);
    for (const scheduledAt of dates) {
      const already = await c.inspections.countDocuments({
        organizationId,
        rentalId: rental._id,
        source: 'SCHEDULED',
        scheduledAt,
      });
      if (already > 0) {
        result.existing += 1;
        continue;
      }
      const open = await c.inspections.findOne({
        organizationId,
        rentalId: rental._id,
        status: { $in: ['PENDING', 'SUBMITTED'] },
        scheduledAt: {
          $gte: addDaysIso(scheduledAt, -OPEN_INSPECTION_TOLERANCE_DAYS),
          $lte: addDaysIso(scheduledAt, OPEN_INSPECTION_TOLERANCE_DAYS),
        },
      });
      if (open) {
        result.skippedOpen += 1;
        continue;
      }

      const [vehicle, driver] = await Promise.all([
        c.vehicles.findOne({ _id: rental.vehicleId, organizationId }),
        c.drivers.findOne({ _id: rental.driverId, organizationId }),
      ]);
      if (!vehicle || vehicle.archivedAt || !driver) continue;

      const built = await buildInspectionDoc(ctx, {
        organization,
        organizationId,
        vehicleId: vehicle._id,
        rental,
        driver,
        responsibleName: driver.fullName,
        phone: driver.phone,
        email: driver.emailLower,
        scheduledAt,
        notes: `Vistoria recorrente (${rental.inspectionRule.period === 'WEEKLY' ? 'semanal' : 'mensal'}) da locação ${rental.rentalNumber}.`,
        source: 'SCHEDULED',
        createdBy: null,
      });
      built.doc.delivery = built.plan.guided
        ? {
            channel: 'WHATSAPP',
            status: 'PENDING',
            message: `Solicitação agendada para ${formatDateTimeLocal(built.plan.scheduledSendAt!)}.`,
            manualLink: built.link,
            attempts: 0,
          }
        : {
            channel: 'MANUAL',
            status: 'UNAVAILABLE',
            message:
              built.plan.reason ??
              'Coleta automática pelo WhatsApp indisponível — envie o link ao motorista manualmente.',
            manualLink: built.link,
            attempts: 0,
          };

      try {
        await c.inspections.insertOne(built.doc);
      } catch (err) {
        // Outra instância criou a mesma ocorrência primeiro (índice único).
        if ((err as { code?: number }).code === 11000) {
          result.existing += 1;
          continue;
        }
        throw err;
      }
      result.created += 1;
      await audit(ctx, {
        organizationId,
        actorId: null,
        action: 'inspection.scheduled_generated',
        entityType: 'inspection',
        entityId: built.doc._id,
        after: {
          rentalId: rental._id.toHexString(),
          scheduledAt,
          rule: rental.inspectionRule,
          channel: built.plan.guided ? 'WHATSAPP' : 'MANUAL',
        },
        correlationId: built.doc.collection?.correlationId ?? null,
      });
      if (!built.plan.guided) {
        await createNotification(ctx, {
          organizationId,
          type: 'INSPECTION',
          severity: 'WARNING',
          title: 'Vistoria recorrente aguardando envio',
          message: `${vehicle.plate} · ${driver.fullName}: envie o link da vistoria de ${scheduledAt.split('-').reverse().join('/')} manualmente.`,
          subjectLabel: vehicle.plate,
          entityType: 'inspection',
          entityId: built.doc._id,
          targetPath: `/dashboard/inspections/${vehicle._id.toHexString()}`,
          dedupeKey: `inspection-generated-manual:${built.doc._id.toHexString()}`,
        });
      }
    }
  }
  return result;
}

