import type { MaintenanceReportData } from '../pdf/maintenance-report.js';

/**
 * Fixture de equivalência do golden master
 * (`manutencoes-ebr7g53-2026-11-08.pdf`).
 *
 * Contém apenas dados do VEÍCULO e das ORDENS DE SERVIÇO — nenhum dado
 * pessoal das capturas. É usado exclusivamente em teste/verificação,
 * conforme a diretriz de LGPD do prompt (§8.5).
 */
export function goldenMaintenanceReportFixture(): MaintenanceReportData {
  return {
    organizationName: 'FF Veículos',
    // 08/11/2026 16:29 em America/Sao_Paulo (UTC-3) => 19:29 UTC
    issuedAt: new Date('2026-11-08T19:29:00.000Z'),
    vehicle: {
      plate: 'EBR7G53',
      brand: 'VW',
      model: 'GOL MPI',
      year: 2023,
      color: 'BRANCA',
      renavam: '01317572928',
      vin: '9BWAG45UOPT048356',
      mileageKm: 181652,
      status: 'RENTED',
      purchaseDate: null,
    },
    orders: [
      {
        orderNumber: 'WO-2026-0013',
        type: 'CORRECTIVE',
        status: 'COMPLETED',
        description: 'TROCA DE DISCO DE FREIO E PASTILHA',
        openedAt: '2026-10-13',
        scheduledAt: null,
        performedAt: '2026-10-12',
        completedAt: '2026-10-12',
        mileageKm: 178209,
        laborCostCents: 25000,
        partsCostCents: 36970,
        totalCents: 61970,
        paymentMethodLabel: 'À vista',
        items: [
          {
            name: 'DISCO DE FREIO E PASTILHA',
            quantity: 1,
            unitCostCents: 36970,
            subtotalCents: 36970,
            supplier: 'MERCADO CAR',
            warrantyUntil: null,
            nextDueDate: null,
          },
        ],
      },
      {
        orderNumber: 'WO-2026-0006',
        type: 'CORRECTIVE',
        status: 'COMPLETED',
        description: 'TROCA DE ÓLEO E FILTRO DE ÓLEO',
        openedAt: '2026-09-05',
        scheduledAt: null,
        performedAt: '2026-09-05',
        completedAt: '2026-09-05',
        mileageKm: null,
        laborCostCents: 0,
        partsCostCents: 21150,
        totalCents: 21150,
        paymentMethodLabel: 'À vista',
        items: [
          {
            name: 'OLEO E FILTRO DE OLEO',
            quantity: 1,
            unitCostCents: 21150,
            subtotalCents: 21150,
            supplier: 'ESTAÇÃO DO OLEO',
            warrantyUntil: null,
            nextDueDate: null,
          },
        ],
      },
    ],
  };
}
