import { describe, expect, it } from 'vitest';
import {
  computeMaintenanceTotalCents,
  computePartsCostCents,
  formatCentsBRL,
  isValidCnpj,
  isValidCpf,
  isValidPlate,
  normalizePlate,
  parseBRLToCents,
  percentDelta,
  plateSchema,
  previousPeriod,
  addMonthsIso,
  lastMonths,
  renderMessage,
  can,
  fullMatrix,
  vehicleInputSchema,
  rentalCreateSchema,
  photoSlotsUpdateSchema,
  MAX_ACTIVE_PHOTO_SLOTS,
} from '../index.js';

describe('dinheiro em centavos', () => {
  it('converte entradas pt-BR para centavos sem erro de ponto flutuante', () => {
    expect(parseBRLToCents('R$ 1.720,45')).toBe(172045);
    expect(parseBRLToCents('5.603,00')).toBe(560300);
    expect(parseBRLToCents('0,01')).toBe(1);
    expect(parseBRLToCents('')).toBe(0);
    expect(parseBRLToCents('369.70')).toBe(36970);
  });

  it('formata centavos em BRL', () => {
    expect(formatCentsBRL(83120).replace(/\u00a0/g, ' ')).toBe('R$ 831,20');
    expect(formatCentsBRL(1151113).replace(/\u00a0/g, ' ')).toBe('R$ 11.511,13');
  });
});

describe('totais da ordem de serviço (golden master EBR7G53)', () => {
  const os13 = { labor: 25000, items: [{ quantity: 1, unitCostCents: 36970 }] };
  const os06 = { labor: 0, items: [{ quantity: 1, unitCostCents: 21150 }] };

  it('reproduz os valores do relatório de referência', () => {
    expect(computeMaintenanceTotalCents(os13.labor, os13.items)).toBe(61970);
    expect(computeMaintenanceTotalCents(os06.labor, os06.items)).toBe(21150);
    const total = 61970 + 21150;
    expect(total).toBe(83120);
    expect(os13.labor + os06.labor).toBe(25000);
    expect(computePartsCostCents([...os13.items, ...os06.items])).toBe(58120);
    expect(Math.round(total / 2)).toBe(41560);
  });
});

describe('validadores brasileiros', () => {
  it('valida CPF', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCpf('123')).toBe(false);
  });

  it('valida CNPJ', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11.222.333/0001-82')).toBe(false);
  });

  it('normaliza e valida placas Mercosul e antigas', () => {
    expect(normalizePlate('ebr-7g53')).toBe('EBR7G53');
    expect(isValidPlate('EBR7G53')).toBe(true);
    expect(isValidPlate('ABC1234')).toBe(true);
    expect(isValidPlate('AB1234')).toBe(false);
    expect(plateSchema.parse(' ebr7g53 ')).toBe('EBR7G53');
  });
});

describe('períodos e variações', () => {
  it('retorna null quando não há base de comparação', () => {
    expect(percentDelta(100, 0)).toBeNull();
    expect(percentDelta(0, 0)).toBe(0);
    expect(percentDelta(50, 100)).toBe(-50);
  });

  it('calcula a janela anterior do mesmo comprimento', () => {
    expect(previousPeriod('2026-11-01', '2026-11-30')).toEqual({ from: '2026-10-02', to: '2026-10-31' });
  });

  it('soma meses preservando o último dia válido', () => {
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsIso('2026-11-08', 1)).toBe('2026-12-08');
  });

  it('gera a série dos últimos meses', () => {
    expect(lastMonths(2026, 11, 6).map((m) => m.key)).toEqual([
      '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11',
    ]);
  });
});

describe('mensagens', () => {
  it('substitui os tokens do editor', () => {
    expect(
      renderMessage('Olá, *{{nome_motorista}}*! Equipe {{nome_empresa}}', {
        driverName: 'João Silva',
        companyName: 'FF Veículos',
      }),
    ).toBe('Olá, *João Silva*! Equipe FF Veículos');
  });
});

describe('permissões', () => {
  it('owner acessa tudo', () => {
    expect(can('OWNER', {}, 'finance', 'pay')).toBe(true);
  });

  it('member sem módulo não acessa', () => {
    expect(can('MEMBER', { vehicles: ['read'] }, 'finance', 'read')).toBe(false);
    expect(can('MEMBER', { vehicles: ['read'] }, 'vehicles', 'read')).toBe(true);
    expect(can('MEMBER', { vehicles: ['read'] }, 'vehicles', 'delete')).toBe(false);
    expect(can('MEMBER', fullMatrix(), 'vehicles', 'delete')).toBe(true);
  });
});

describe('schemas de entrada', () => {
  it('rejeita hodômetro negativo', () => {
    const result = vehicleInputSchema.safeParse({
      plate: 'EBR7G53', brand: 'VW', model: 'GOL MPI', mileageKm: -1,
    });
    expect(result.success).toBe(false);
  });

  it('exige término >= início na locação', () => {
    const base = {
      vehicleId: '507f1f77bcf86cd799439011',
      driverId: '507f1f77bcf86cd799439012',
      startDate: '2026-11-10',
      endDate: '2026-11-01',
      rentalType: 'MONTHLY' as const,
      periodicAmountCents: 70000,
    };
    expect(rentalCreateSchema.safeParse(base).success).toBe(false);
    expect(rentalCreateSchema.safeParse({ ...base, endDate: '2026-12-10' }).success).toBe(true);
  });

  it('limita slots ativos de vistoria a 12', () => {
    const slots = Array.from({ length: MAX_ACTIVE_PHOTO_SLOTS + 1 }, (_, i) => ({
      label: `Foto ${i + 1}`,
      active: true,
    }));
    expect(photoSlotsUpdateSchema.safeParse({ slots }).success).toBe(false);
    expect(
      photoSlotsUpdateSchema.safeParse({ slots: slots.slice(0, MAX_ACTIVE_PHOTO_SLOTS) }).success,
    ).toBe(true);
  });
});

describe('aritmética do extrato (referência pág. 85)', () => {
  it('saldo final = inicial + entradas - saídas', () => {
    const opening = 780258;
    const inflow = 560300;
    const outflow = 189445;
    expect(opening + inflow - outflow).toBe(1151113);
  });
});
