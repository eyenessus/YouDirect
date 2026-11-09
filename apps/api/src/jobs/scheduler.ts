import type { FastifyBaseLogger } from 'fastify';
import { businessDate } from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { runNotificationGenerators } from '../services/notifications.js';
import { generateRecurringPayables, refreshOverdueStatuses } from '../services/finance.js';

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

export function startScheduler(ctx: AppContext, logger: FastifyBaseLogger): () => void {
  if (!ctx.env.JOBS_ENABLED) {
    logger.info('JOBS_ENABLED=false — rotinas periódicas desativadas.');
    return () => undefined;
  }
  const intervalMs = ctx.env.JOBS_INTERVAL_MINUTES * 60 * 1000;
  void runScheduledJobs(ctx, logger);
  const timer = setInterval(() => void runScheduledJobs(ctx, logger), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
