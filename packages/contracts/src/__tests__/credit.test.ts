import { describe, expect, it } from 'vitest';
import {
  can,
  countsAsBillable,
  creditCheckRequestSchema,
  creditMonth,
  creditReviewSchema,
  creditSettingsSchema,
  defaultCreditSettings,
  fullMatrix,
  permissionMatrixSchema,
} from '../index.js';

describe('análise de crédito — regras compartilhadas', () => {
  const valid = {
    purpose: 'PRE_LOCACAO',
    justification: 'Análise antes da entrega do carro',
    holderInformed: true,
    confirmCost: true,
    idempotencyKey: 'chave-123456',
  };

  it('pedido exige finalidade, justificativa, ciência do titular e do custo', () => {
    expect(creditCheckRequestSchema.parse(valid)).toMatchObject({ forceNew: false });
    expect(creditCheckRequestSchema.safeParse({ ...valid, justification: 'curto' }).success).toBe(false);
    expect(creditCheckRequestSchema.safeParse({ ...valid, holderInformed: false }).success).toBe(false);
    expect(creditCheckRequestSchema.safeParse({ ...valid, confirmCost: false }).success).toBe(false);
    expect(creditCheckRequestSchema.safeParse({ ...valid, purpose: 'CURIOSIDADE' }).success).toBe(false);
    expect(creditCheckRequestSchema.safeParse({ ...valid, idempotencyKey: 'x' }).success).toBe(false);
  });

  it('decisão sempre com justificativa', () => {
    expect(creditReviewSchema.safeParse({ decision: 'RECUSADO', notes: '' }).success).toBe(false);
    expect(creditReviewSchema.safeParse({ decision: 'APROVADO', notes: 'Sem pendências relevantes.' }).success).toBe(true);
    expect(creditReviewSchema.safeParse({ decision: 'AUTOMATICO', notes: 'xxxxx' }).success).toBe(false);
  });

  it('configuração: começa desligada e com limites seguros', () => {
    expect(defaultCreditSettings.enabled).toBe(false);
    expect(creditSettingsSchema.parse(defaultCreditSettings)).toEqual(defaultCreditSettings);
    expect(creditSettingsSchema.safeParse({ ...defaultCreditSettings, reuseDays: 365 }).success).toBe(false);
    expect(creditSettingsSchema.safeParse({ ...defaultCreditSettings, retentionDays: 1 }).success).toBe(false);
  });

  it('o que conta como cobrado', () => {
    expect(countsAsBillable('COMPLETED')).toBe(true);
    expect(countsAsBillable('UNCERTAIN')).toBe(true);
    expect(countsAsBillable('NOT_AVAILABLE')).toBe(true);
    expect(countsAsBillable('FAILED')).toBe(false);
  });

  it('mês no fuso de São Paulo', () => {
    expect(creditMonth(new Date('2026-11-01T02:59:00Z'))).toBe('2026-10');
    expect(creditMonth(new Date('2026-11-01T03:00:00Z'))).toBe('2026-11');
  });

  it('permissão de crédito: negada por padrão para colaborador', () => {
    expect(can('MEMBER', { drivers: ['read'] }, 'credit', 'read')).toBe(false);
    expect(can('MEMBER', { credit: ['read'] }, 'credit', 'request')).toBe(false);
    expect(can('MEMBER', { credit: ['read', 'request'] }, 'credit', 'request')).toBe(true);
    expect(can('ADMIN', {}, 'credit', 'review')).toBe(true);
    expect(permissionMatrixSchema.safeParse({ credit: ['pay'] }).success).toBe(false);
    expect(fullMatrix().credit).toEqual(['read', 'request', 'review']);
  });
});
