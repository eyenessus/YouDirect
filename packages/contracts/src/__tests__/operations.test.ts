import { describe, expect, it } from 'vitest';
import {
  computeExtraKm,
  defaultLoyaltySettings,
  levelForScore,
  loyaltySettingsSchema,
  rentalKmPolicySchema,
  scoreLoyalty,
} from '../index.js';

describe('computeExtraKm', () => {
  const base = { baselineKm: 10_000, daysSinceStart: 7, weeklyFranchiseKm: 1500, alreadyChargedKm: 0 };

  it('dentro da franquia não cobra', () => {
    expect(computeExtraKm({ ...base, odometerKm: 11_400 })).toEqual({ drivenKm: 1400, allowedKm: 1500, excessKm: 0, toChargeKm: 0 });
  });

  it('cobra só o que passou da franquia proporcional', () => {
    expect(computeExtraKm({ ...base, odometerKm: 11_800 })).toMatchObject({ drivenKm: 1800, allowedKm: 1500, excessKm: 300, toChargeKm: 300 });
    // 10 dias = 1500 × 10/7 ≈ 2143 km de franquia
    expect(computeExtraKm({ ...base, daysSinceStart: 10, odometerKm: 12_500 })).toMatchObject({ allowedKm: 2143, excessKm: 357 });
  });

  it('desconta o que já foi cobrado (nunca cobra duas vezes)', () => {
    expect(computeExtraKm({ ...base, odometerKm: 11_800, alreadyChargedKm: 300 }).toChargeKm).toBe(0);
    expect(computeExtraKm({ ...base, odometerKm: 11_900, alreadyChargedKm: 300 }).toChargeKm).toBe(100);
  });

  it('sem franquia (km livre) e leitura abaixo da base não cobram', () => {
    expect(computeExtraKm({ ...base, weeklyFranchiseKm: null, odometerKm: 50_000 }).toChargeKm).toBe(0);
    expect(computeExtraKm({ ...base, odometerKm: 9_000 })).toMatchObject({ drivenKm: 0, toChargeKm: 0 });
  });

  it('dia zero conta como 1 dia de franquia', () => {
    expect(computeExtraKm({ ...base, daysSinceStart: 0, odometerKm: 10_100 }).allowedKm).toBe(214);
  });

  it('política valida valores', () => {
    expect(rentalKmPolicySchema.safeParse({ weeklyFranchiseKm: 1500, extraKmPriceCents: 75, startOdometerKm: null }).success).toBe(true);
    expect(rentalKmPolicySchema.safeParse({ weeklyFranchiseKm: -1, extraKmPriceCents: 75, startOdometerKm: null }).success).toBe(false);
  });
});

describe('fidelidade', () => {
  const zero = { tenureDays: 0, overdueInvoices: 0, paidOnTimeInvoices: 0, inspectionsOnTime: 0, inspectionsLate: 0, recentFines: 0 };

  it('motorista novo começa no nível Inicial', () => {
    const { score } = scoreLoyalty(zero);
    expect(score).toBe(0);
    expect(levelForScore(defaultLoyaltySettings, score).level.code).toBe('INICIAL');
  });

  it('tempo, pagamentos e vistorias somam; multas e atrasos tiram', () => {
    const good = scoreLoyalty({ ...zero, tenureDays: 180, paidOnTimeInvoices: 20, inspectionsOnTime: 6 });
    expect(good.score).toBe(60 + 80 + 30);
    expect(levelForScore(defaultLoyaltySettings, good.score).level.code).toBe('INTERMEDIARIO');
    const bad = scoreLoyalty({ ...zero, tenureDays: 180, paidOnTimeInvoices: 20, overdueInvoices: 3, recentFines: 2 });
    expect(bad.score).toBe(60 + 40 - 30);
  });

  it('cada critério tem teto e a pontuação nunca é negativa', () => {
    const capped = scoreLoyalty({ ...zero, tenureDays: 5000, paidOnTimeInvoices: 999, inspectionsOnTime: 999 });
    expect(capped.score).toBe(120 + 80 + 40);
    expect(scoreLoyalty({ ...zero, overdueInvoices: 10, recentFines: 10, inspectionsLate: 10 }).score).toBe(0);
  });

  it('sinistro com culpa tira 40 pontos cada, com teto de 80, e a falta do dado não pesa', () => {
    const base = { ...zero, tenureDays: 180, paidOnTimeInvoices: 20, inspectionsOnTime: 6 };
    expect(scoreLoyalty(base).score).toBe(170);
    expect(scoreLoyalty({ ...base, recentClaims: 1 }).score).toBe(130);
    expect(scoreLoyalty({ ...base, recentClaims: 9 }).score).toBe(90);
    expect(scoreLoyalty({ ...base, recentClaims: 2 }).criteria.find((c) => c.key === 'CLAIMS')?.detail).toContain('2 sinistro(s)');
  });

  it('próximo nível e topo', () => {
    expect(levelForScore(defaultLoyaltySettings, 100).next?.code).toBe('INTERMEDIARIO');
    expect(levelForScore(defaultLoyaltySettings, 999)).toMatchObject({ level: { code: 'ESPECIAL' }, next: null });
  });

  it('configuração exige primeiro nível em 0 e pontuação crescente', () => {
    expect(loyaltySettingsSchema.safeParse(defaultLoyaltySettings).success).toBe(true);
    const bad = { ...defaultLoyaltySettings, levels: [defaultLoyaltySettings.levels[1]!, defaultLoyaltySettings.levels[0]!] };
    expect(loyaltySettingsSchema.safeParse(bad).success).toBe(false);
  });
});
