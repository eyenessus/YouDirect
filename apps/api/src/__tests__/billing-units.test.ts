import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { defaultBillingSettings } from '@yudirect/contracts';
import { mpDate, verifyMercadoPagoSignature } from '../integrations/mercadopago.js';
import { reminderBucket, reminderMessage } from '../services/billing-reminders.js';

const SECRET = 'segredo-de-teste-do-webhook';
const sign = (dataId: string, requestId: string, ts: number, secret = SECRET) =>
  `ts=${ts},v1=${createHmac('sha256', secret).update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex')}`;

describe('assinatura do webhook do Mercado Pago', () => {
  const now = 1_790_000_000_000;

  it('aceita a assinatura correta', () => {
    expect(verifyMercadoPagoSignature({ secret: SECRET, signatureHeader: sign('123456', 'req-1', now), requestId: 'req-1', dataId: '123456', now })).toBe(true);
  });

  it('data.id alfanumérico é comparado em minúsculas (regra da documentação)', () => {
    const header = sign('ORD01JQ4S4KY8', 'req-2', now);
    expect(verifyMercadoPagoSignature({ secret: SECRET, signatureHeader: header, requestId: 'req-2', dataId: 'ORD01JQ4S4KY8', now })).toBe(true);
  });

  it('recusa segredo errado, id trocado, sem cabeçalho e cabeçalho malformado', () => {
    const header = sign('123456', 'req-1', now, 'outro-segredo');
    expect(verifyMercadoPagoSignature({ secret: SECRET, signatureHeader: header, requestId: 'req-1', dataId: '123456', now })).toBe(false);
    expect(verifyMercadoPagoSignature({ secret: SECRET, signatureHeader: sign('123456', 'req-1', now), requestId: 'req-1', dataId: '999', now })).toBe(false);
    expect(verifyMercadoPagoSignature({ secret: SECRET, signatureHeader: undefined, requestId: 'req-1', dataId: '123456', now })).toBe(false);
    expect(verifyMercadoPagoSignature({ secret: SECRET, signatureHeader: 'lixo', requestId: 'req-1', dataId: '123456', now })).toBe(false);
  });

  it('recusa notificação antiga (proteção contra replay)', () => {
    const old = now - 20 * 60 * 1000;
    expect(verifyMercadoPagoSignature({ secret: SECRET, signatureHeader: sign('123456', 'req-1', old), requestId: 'req-1', dataId: '123456', now })).toBe(false);
  });

  it('data de expiração no formato aceito pelo Mercado Pago', () => {
    expect(mpDate(new Date('2026-11-10T15:30:00.000Z'))).toBe('2026-11-10T12:30:00.000-03:00');
  });
});

describe('régua de cobrança', () => {
  const s = defaultBillingSettings; // 2 dias antes, no dia, 1 e 3 dias depois

  it('marcos D-2, D0, D+1, D+3 e nada nos outros dias', () => {
    expect(reminderBucket('2026-11-12', '2026-11-10', s)).toBe('D-2');
    expect(reminderBucket('2026-11-10', '2026-11-10', s)).toBe('D0');
    expect(reminderBucket('2026-11-09', '2026-11-10', s)).toBe('D+1');
    expect(reminderBucket('2026-11-07', '2026-11-10', s)).toBe('D+3');
    expect(reminderBucket('2026-11-11', '2026-11-10', s)).toBeNull();
    expect(reminderBucket('2026-11-08', '2026-11-10', s)).toBeNull();
    expect(reminderBucket('2026-11-20', '2026-11-10', s)).toBeNull();
  });

  it('mensagem cita valor, vencimento e o link da Área do Motorista', () => {
    const msg = reminderMessage({
      driverName: 'Ana Souza',
      companyName: 'FF Veículos',
      invoice: { description: 'Semana 3', remainingCents: 70000, dueDate: '2026-11-07' },
      bucket: 'D+3',
      portalUrl: 'https://app/motorista/faturas',
    });
    expect(msg).toContain('Olá, Ana!');
    expect(msg).toMatch(/R\$\s700,00/);
    expect(msg).toContain('venceu em 07/11/2026');
    expect(msg).toContain('https://app/motorista/faturas');
  });
});
