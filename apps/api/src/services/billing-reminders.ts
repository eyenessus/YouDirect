import { ObjectId } from 'mongodb';
import {
  addDaysIso,
  businessDate,
  businessTime,
  defaultBillingSettings,
  diffDaysIso,
  formatCentsBRL,
  formatIsoDateBR,
  type BillingSettings,
  type PortalInvoice,
} from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { portalInvoices } from './driver-portal.js';

/* ------------------------------------------------------------------ *
 * Régua de cobrança pelo WhatsApp: lembrete antes do vencimento, no dia
 * e depois (atraso). Uma mensagem por fatura e marco (índice único), só
 * em horário comercial e só com o provedor de WhatsApp conectado — sem
 * provedor nada é "enviado" de mentira.
 * ------------------------------------------------------------------ */

export function billingSettingsOf(settings: { billing?: BillingSettings } | undefined): BillingSettings {
  return settings?.billing ?? defaultBillingSettings;
}

/** Marco da régua para a fatura hoje (ou null se hoje não é dia de lembrar). */
export function reminderBucket(dueDate: string, today: string, settings: BillingSettings): string | null {
  const days = diffDaysIso(dueDate, today); // >0 = faltam dias; <0 = atrasada
  if (days > 0 && days === settings.reminderDaysBefore) return `D-${days}`;
  if (days === 0) return 'D0';
  if (days < 0 && settings.overdueReminderDays.includes(-days)) return `D+${-days}`;
  return null;
}

export function reminderMessage(params: {
  driverName: string;
  companyName: string;
  invoice: Pick<PortalInvoice, 'description' | 'remainingCents' | 'dueDate'>;
  bucket: string;
  portalUrl: string;
}): string {
  const first = params.driverName.split(' ')[0] ?? params.driverName;
  const value = formatCentsBRL(params.invoice.remainingCents);
  const date = formatIsoDateBR(params.invoice.dueDate);
  const head =
    params.bucket === 'D0'
      ? `Olá, ${first}! Sua fatura (${params.invoice.description}) de ${value} vence hoje.`
      : params.bucket.startsWith('D-')
        ? `Olá, ${first}! Lembrete: sua fatura (${params.invoice.description}) de ${value} vence em ${date}.`
        : `Olá, ${first}! Sua fatura (${params.invoice.description}) de ${value} venceu em ${date} e ainda está em aberto.`;
  return [
    head,
    `Pague pelo Pix na Área do Motorista: ${params.portalUrl}`,
    `Qualquer dúvida, responda esta mensagem. — ${params.companyName || 'Locadora'}`,
  ].join('\n');
}

export async function generateBillingReminders(
  ctx: AppContext,
  organizationId: ObjectId,
  now = new Date(),
): Promise<{ sent: number; failed: number; skipped: number }> {
  const out = { sent: 0, failed: 0, skipped: 0 };
  if (!ctx.integrations.whatsapp.status().connected) return out;
  const org = await ctx.mongo.collections.organizations.findOne({ _id: organizationId });
  if (!org) return out;
  const settings = billingSettingsOf(org.settings);
  if (!settings.remindersEnabled) return out;
  // Só entre 9h e 20h no fuso da empresa.
  const hour = Number(businessTime(now).slice(0, 2));
  if (hour < 9 || hour >= 20) return out;

  const today = businessDate(now);
  const driverIds = await ctx.mongo.collections.rentals.distinct('driverId', {
    organizationId,
    status: { $ne: 'CANCELED' },
    $or: [{ status: 'ACTIVE' }, { endDate: { $gte: addDaysIso(today, -60) } }],
  });
  const portalUrl = `${ctx.env.APP_URL.replace(/\/$/, '')}/motorista/faturas`;

  for (const driverId of driverIds as ObjectId[]) {
    const driver = await ctx.mongo.collections.drivers.findOne({ _id: driverId, organizationId });
    if (!driver || driver.archivedAt || driver.anonymizedAt || driver.whatsappConsent?.status === 'REVOKED') {
      out.skipped += 1;
      continue;
    }
    const { invoices } = await portalInvoices(ctx, { organizationId, driverId, sessionId: new ObjectId() }, today);
    for (const invoice of invoices) {
      if (invoice.status === 'PAID' || invoice.remainingCents <= 0) continue;
      const bucket = reminderBucket(invoice.dueDate, today, settings);
      if (!bucket) continue;
      // Reserva o marco antes de enviar: dois jobs simultâneos não mandam duas mensagens.
      try {
        await ctx.mongo.collections.billingReminders.insertOne({
          _id: new ObjectId(),
          organizationId,
          driverId,
          invoiceKey: invoice.key,
          dueDate: invoice.dueDate,
          bucket,
          status: 'SENT',
          error: null,
          createdAt: now,
          updatedAt: now,
        });
      } catch (err) {
        if ((err as { code?: number }).code === 11000) continue;
        throw err;
      }
      const body = reminderMessage({ driverName: driver.fullName, companyName: org.name, invoice, bucket, portalUrl });
      const res = await ctx.integrations.whatsapp.send(driver.phone, body, `billing:${invoice.key}:${bucket}`);
      if (res.delivered) out.sent += 1;
      else {
        out.failed += 1;
        await ctx.mongo.collections.billingReminders.updateOne(
          { organizationId, invoiceKey: invoice.key, bucket },
          { $set: { status: 'FAILED', error: res.error, updatedAt: new Date() } },
        );
      }
    }
  }
  return out;
}
