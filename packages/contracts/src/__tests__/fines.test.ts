import { describe, expect, it } from 'vitest';
import {
  businessDate,
  businessTime,
  canTransitionFine,
  fineChargeAmountCents,
  normalizeAitNumber,
  trafficFineCreateSchema,
  zonedDateTimeToUtc,
} from '../index.js';

describe('zonedDateTimeToUtc', () => {
  it('converte horário de São Paulo para UTC (UTC-3)', () => {
    expect(zonedDateTimeToUtc('2026-11-10', '23:30').toISOString()).toBe('2026-11-11T02:30:00.000Z');
    expect(zonedDateTimeToUtc('2026-01-01', '00:00').toISOString()).toBe('2026-01-01T03:00:00.000Z');
  });

  it('faz ida e volta com businessDate/businessTime (sem armadilha do UTC)', () => {
    const instant = zonedDateTimeToUtc('2026-11-10', '23:30');
    expect(businessDate(instant)).toBe('2026-11-10');
    expect(businessTime(instant)).toBe('23:30');
  });
});

describe('máquina de estados da multa', () => {
  it('permite o fluxo principal', () => {
    expect(canTransitionFine('RECEIVED', 'DRIVER_IDENTIFIED')).toBe(true);
    expect(canTransitionFine('DRIVER_IDENTIFIED', 'INDICATED')).toBe(true);
    expect(canTransitionFine('INDICATED', 'CHARGED')).toBe(true);
    expect(canTransitionFine('DRIVER_IDENTIFIED', 'CHARGED')).toBe(true);
    expect(canTransitionFine('CHARGED', 'PAID')).toBe(true);
  });

  it('bloqueia saltos e estados terminais', () => {
    expect(canTransitionFine('RECEIVED', 'CHARGED')).toBe(false);
    expect(canTransitionFine('RECEIVED', 'PAID')).toBe(false);
    expect(canTransitionFine('CANCELED', 'RECEIVED')).toBe(false);
    expect(canTransitionFine('COMPANY_LIABLE', 'CHARGED')).toBe(false);
    expect(canTransitionFine('PAID', 'INDICATED')).toBe(false);
    expect(canTransitionFine('INDICATED', 'DRIVER_IDENTIFIED')).toBe(false);
  });

  it('recurso pode voltar ao estado anterior ou cancelar', () => {
    expect(canTransitionFine('CHARGED', 'CONTESTED')).toBe(true);
    expect(canTransitionFine('CONTESTED', 'CHARGED')).toBe(true);
    expect(canTransitionFine('CONTESTED', 'CANCELED')).toBe(true);
  });
});

describe('valor a cobrar', () => {
  const fine = { amountCents: 29347, discountedAmountCents: 23478, discountUntil: '2026-11-20', adminFeeCents: 1000 };
  it('usa o desconto até a data limite e soma a taxa', () => {
    expect(fineChargeAmountCents(fine, '2026-11-20')).toBe(24478);
  });
  it('usa o valor cheio depois da data limite', () => {
    expect(fineChargeAmountCents(fine, '2026-11-21')).toBe(30347);
  });
  it('sem desconto informado usa o valor cheio', () => {
    expect(fineChargeAmountCents({ ...fine, discountedAmountCents: null, discountUntil: null }, '2026-11-01')).toBe(30347);
  });
});

describe('cadastro', () => {
  const base = {
    vehicleId: '0123456789abcdef01234567',
    aitNumber: 'a1-23.456',
    authorityName: 'DETRAN-SP',
    infractionDescription: 'Avançar sinal vermelho',
    occurredDate: '2026-11-10',
    occurredTime: '08:15',
    amountCents: 29347,
  };
  it('normaliza o AIT', () => {
    expect(normalizeAitNumber(base.aitNumber)).toBe('A123456');
  });
  it('recusa desconto maior que o valor', () => {
    const res = trafficFineCreateSchema.safeParse({ ...base, discountedAmountCents: 30000 });
    expect(res.success).toBe(false);
  });
  it('recusa hora inválida', () => {
    expect(trafficFineCreateSchema.safeParse({ ...base, occurredTime: '24:00' }).success).toBe(false);
  });
  it('aceita o cadastro mínimo', () => {
    const res = trafficFineCreateSchema.parse(base);
    expect(res.adminFeeCents).toBe(0);
  });
});
