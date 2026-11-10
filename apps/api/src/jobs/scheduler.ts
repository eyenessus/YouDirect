import type { FastifyBaseLogger } from 'fastify';
import { businessDate } from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { runNotificationGenerators } from '../services/notifications.js';
import { generateRecurringPayables, refreshOverdueStatuses } from '../services/finance.js';
import {
  dispatchDueInspections,
  reconcileMessages,
  runCollectionLifecycle,
  sendPendingMessages,
} from '../services/whatsapp-inspection.js';
import { withLease } from './lease.js';

/**
 * Rotinas periódicas idempotentes.
 * Todas usam a data efetiva do sistema e chaves de deduplicação, de modo
 * que executar várias vezes não gera alertas nem lançamentos repetidos.
 */
export async function runScheduledJobs(ctx: AppContext, logger: FastifyBaseLogger): Promise<void> {
  const today = businessDate();
  const organizations = await ctx.mongo.collections.organizations.find({}).toArray();

  for (const organization of organizations) {
    try {
      const notifications = await runNotificationGenerators(ctx, organization._id, today);
      const recurring = await generateRecurringPayables(ctx, organization._id, today);
      const statuses = await refreshOverdueStatuses(ctx, organization._id, today);
      logger.info(
        {
          organization: organization.name,
          notifications,
          recurringPayables: recurring,
          overdueReceivables: statuses.receivables,
          overduePayables: statuses.payables,
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
