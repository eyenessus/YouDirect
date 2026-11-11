import type { FastifyBaseLogger } from 'fastify';
import { businessDate } from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { runNotificationGenerators } from '../services/notifications.js';
import { reconcilePixCharges } from '../services/pix.js';
import { generateBillingEscalations, generateBillingReminders } from '../services/billing-reminders.js';
import { recomputeLoyalty } from '../services/loyalty.js';
import { reconcileSignatures } from '../services/contract-signature.js';
import { expireStaleCreditChecks, purgeExpiredCreditReports } from '../services/credit.js';
import {
  extendOpenEndedReceivables,
  generateRecurringPayables,
  refreshOverdueStatuses,
} from '../services/finance.js';
import {
  dispatchDueInspections,
  reconcileMessages,
  runCollectionLifecycle,
  sendPendingMessages,
} from '../services/whatsapp-inspection.js';
import { withLease } from './lease.js';
import { generateScheduledInspections } from '../services/inspection-schedule.js';

/**
 * Rotinas periódicas idempotentes.
 * Todas usam a data efetiva do sistema e chaves de deduplicação, de modo
 * que executar várias vezes não gera alertas nem lançamentos repetidos.
 */
export async function runScheduledJobs(ctx: AppContext, logger: FastifyBaseLogger): Promise<void> {
  const today = businessDate();
  const organizations = await ctx.mongo.collections.organizations.find({}).toArray();
  // Serasa: retenção dos relatórios e consultas interrompidas (globais, sem nova chamada).
  try {
    const purged = await purgeExpiredCreditReports(ctx);
    const stale = await expireStaleCreditChecks(ctx);
    if (purged || stale) logger.info({ creditReportsPurged: purged, creditChecksInterrupted: stale }, 'retenção Serasa');
  } catch (err) {
    logger.error({ err }, 'falha na retenção dos relatórios Serasa');
  }

  for (const organization of organizations) {
    try {
      const notifications = await runNotificationGenerators(ctx, organization._id, today);
      const recurring = await generateRecurringPayables(ctx, organization._id, today);
      // Vistorias recorrentes pela regra da locação (idempotente por índice único).
      const inspections = await generateScheduledInspections(ctx, organization._id, today);
      // Locações sem término: abre a conta do período que começou (antes de recalcular status).
      const extended = await extendOpenEndedReceivables(ctx, organization._id, today);
      const statuses = await refreshOverdueStatuses(ctx, organization._id, today);
      // Cobrança: Pix pendentes (webhook perdido) antes dos lembretes, para não cobrar quem já pagou.
      const pix = await reconcilePixCharges(ctx, organization._id).catch(() => ({ paid: 0, expired: 0 }));
      const reminders = await generateBillingReminders(ctx, organization._id).catch(() => ({ sent: 0, failed: 0, skipped: 0 }));
      const escalations = await generateBillingEscalations(ctx, organization._id, today).catch(() => 0);
      const loyalty = await recomputeLoyalty(ctx, organization._id, today).catch(() => 0);
      const signatures = await reconcileSignatures(ctx, organization._id).catch(() => 0);
      logger.info(
        {
          organization: organization.name,
          notifications,
          recurringPayables: recurring,
          scheduledInspections: inspections.created,
          extendedRentalReceivables: extended,
          overdueReceivables: statuses.receivables,
          overduePayables: statuses.payables,
          pixPaid: pix.paid,
          pixExpired: pix.expired,
          billingRemindersSent: reminders.sent,
          billingEscalations: escalations,
          loyaltyUpdated: loyalty,
          signaturesUpdated: signatures,
        },
        'jobs executados',
      );
    } catch (err) {
      logger.error({ err, organization: organization.name }, 'falha ao executar jobs da organização');
    }
  }
}

/**
 * Ciclo da coleta de vistoria pelo WhatsApp (plano §7): disparo,
 * outbox, reconciliação e lembretes/expiração. Cada etapa é isolada para
 * que a falha de uma não impeça as demais.
 */
export async function runWhatsappJobs(ctx: AppContext, logger: FastifyBaseLogger, now = new Date()): Promise<void> {
  const steps: Array<[string, () => Promise<unknown>]> = [
    ['dispatch', () => dispatchDueInspections(ctx, now)],
    ['outbox', () => sendPendingMessages(ctx, now)],
    ['lifecycle', () => runCollectionLifecycle(ctx, now)],
    ['reconcile', () => reconcileMessages(ctx, now)],
  ];
  for (const [name, step] of steps) {
    try {
      const result = await step();
      logger.debug({ step: name, result }, 'whatsapp job');
    } catch (err) {
      logger.error({ err, step: name }, 'falha no job da integração WhatsApp');
    }
  }
}

export function startScheduler(ctx: AppContext, logger: FastifyBaseLogger): () => void {
  if (!ctx.env.JOBS_ENABLED) {
    logger.info('JOBS_ENABLED=false — rotinas periódicas desativadas.');
    return () => undefined;
  }
  const intervalMs = ctx.env.JOBS_INTERVAL_MINUTES * 60 * 1000;
  // Lease: em várias instâncias, apenas uma executa cada rotina por vez.
  const general = () =>
    void withLease(ctx, 'jobs:general', intervalMs, () => runScheduledJobs(ctx, logger)).catch((err) =>
      logger.error({ err }, 'falha nas rotinas periódicas'),
    );
  general();
  const timer = setInterval(general, intervalMs);
  timer.unref();

  let waTimer: NodeJS.Timeout | null = null;
  if (ctx.integrations.whaply.status().connected) {
    const waInterval = ctx.env.WHAPLY_JOBS_INTERVAL_SECONDS * 1000;
    const whatsapp = () =>
      void withLease(ctx, 'jobs:whatsapp', Math.max(waInterval * 2, 60_000), () => runWhatsappJobs(ctx, logger)).catch((err) =>
        logger.error({ err }, 'falha nos jobs da integração WhatsApp'),
      );
    whatsapp();
    waTimer = setInterval(whatsapp, waInterval);
    waTimer.unref();
  }
  return () => {
    clearInterval(timer);
    if (waTimer) clearInterval(waTimer);
  };
}
