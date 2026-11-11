import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { CreditCheck, CreditIntegrationStatus, MeResponse } from '@yudirect/contracts';

const get = vi.fn();
const post = vi.fn();

const { FakeApiError } = vi.hoisted(() => ({
  FakeApiError: class extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
  ApiRequestError: FakeApiError,
}));
vi.mock('@/router', () => ({ router: { replace: vi.fn() } }));

import DriverCreditCard from '@/features/credit/DriverCreditCard.vue';
import { useAuthStore } from '@/stores/auth';
import { navigation } from '@/components/layout/navigation';

const AppModalStub = defineComponent({
  props: { open: Boolean, title: String, description: String },
  emits: ['close'],
  setup(props, { slots }) {
    return () => (props.open ? h('div', { 'data-modal': props.title }, [slots.default?.()]) : null);
  },
});
const stubs = { AppModal: AppModalStub };

function me(role: 'OWNER' | 'MEMBER', permissions: Record<string, string[]> = {}): MeResponse {
  return {
    user: { id: 'u1', name: 'Erik', email: 'erik@exemplo.test', phone: null, initials: 'E', browserNotificationsEnabled: false },
    organization: { id: 'o1', name: 'FF Veículos', legalId: null, role, permissions: permissions as never },
    organizations: [{ id: 'o1', name: 'FF Veículos', role }],
  };
}

const status = (patch: Partial<CreditIntegrationStatus> = {}): CreditIntegrationStatus => ({
  connected: true,
  environment: 'homologacao',
  message: 'Serasa Experian configurada (homologação).',
  reportName: 'RELATORIO_BASICO_PF_PME',
  optionalFeatures: [],
  scoreModel: null,
  settings: { enabled: true, costPerQueryCents: 1290, monthlyLimit: 50, reuseDays: 30, retentionDays: 90 },
  usage: { month: '2026-11', billable: 1, uncertain: 0, estimatedCostCents: 1290, limit: 50 },
  ...patch,
});

const check: CreditCheck = {
  id: 'c1',
  driverId: 'd1',
  driverName: 'Fulano',
  rentalId: null,
  purpose: 'PRE_LOCACAO',
  justification: 'Análise antes da entrega',
  status: 'COMPLETED',
  outcome: 'REPORT',
  message: null,
  environment: 'homologacao',
  reportName: 'RELATORIO_BASICO_PF_PME',
  billable: 'YES',
  estimatedCostCents: 1290,
  requestedBy: { id: 'u1', name: 'Erik' },
  requestedAt: '2026-11-10T12:00:00.000Z',
  completedAt: '2026-11-10T12:00:02.000Z',
  reportExpiresAt: '2027-02-08T12:00:00.000Z',
  reportPurged: false,
  review: null,
  report: {
    reportName: 'RELATORIO_BASICO_PF_PME',
    consumerName: 'FULANO',
    registrationStatus: 'REGULAR',
    score: { score: 612, model: 'HRLN', range: 'D', defaultRate: '7,5%', message: null },
    scoreMessage: null,
    hasNegative: true,
    negatives: [
      { type: 'PEFIN', availability: 'RETURNED', count: 1, balanceCents: 123456, firstDate: '2026-01-10', lastDate: '2026-01-10', message: null, items: [{ date: '2026-01-10', creditor: 'BANCO EXEMPLO', amountCents: 123456, city: 'SAO PAULO', state: 'SP', subJudice: false }] },
      { type: 'COBRANCA', availability: 'NOT_RETURNED', count: 0, balanceCents: 0, firstDate: null, lastDate: null, message: null, items: [] },
    ],
    stolenDocumentAlerts: 0,
    inquiriesThisMonth: 3,
  },
};

function routeGet(statusValue: CreditIntegrationStatus, checks: CreditCheck[]) {
  get.mockImplementation(async (url: string) => (url === '/credit/status' ? statusValue : { data: checks }));
}

beforeEach(() => {
  setActivePinia(createPinia());
  get.mockReset();
  post.mockReset();
});

describe('Análise de crédito na página do motorista', () => {
  it('mostra score com modelo, anotações por categoria e o aviso de interpretação', async () => {
    useAuthStore().me = me('OWNER');
    routeGet(status(), [check]);
    const w = mount(DriverCreditCard, { props: { driverId: 'd1', hasCpf: true }, global: { stubs } });
    await flushPromises();
    const text = w.text();
    expect(text).toContain('612');
    expect(text).toContain('Modelo HRLN');
    expect(text).toMatch(/1 ocorrência\(s\)/);
    expect(text).toContain('Não incluído no relatório contratado');
    expect(text).toContain('indicador estatístico');
    expect(text).toContain('Homologação');
  });

  it('consulta exige justificativa e as duas confirmações; envia chave de idempotência', async () => {
    useAuthStore().me = me('OWNER');
    routeGet(status(), []);
    post.mockResolvedValue({ check, reused: false });
    const w = mount(DriverCreditCard, { props: { driverId: 'd1', hasCpf: true }, global: { stubs } });
    await flushPromises();
    await w.findAll('button').find((b) => b.text() === 'Consultar Serasa')!.trigger('click');
    const modal = w.find('[data-modal="Consultar Serasa"]');
    expect(modal.exists()).toBe(true);
    expect(modal.text()).toContain('R$');

    await modal.find('form').trigger('submit');
    expect(post).not.toHaveBeenCalled();
    expect(w.text()).toContain('mínimo 10 caracteres');

    await modal.find('textarea').setValue('Motorista novo, retirada na sexta');
    await modal.find('form').trigger('submit');
    expect(post).not.toHaveBeenCalled();

    for (const cb of modal.findAll('input[type="checkbox"]')) await cb.setValue(true);
    await modal.find('form').trigger('submit');
    await flushPromises();
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0]!;
    expect(url).toBe('/drivers/d1/credit-checks');
    expect(body).toMatchObject({ purpose: 'PRE_LOCACAO', holderInformed: true, confirmCost: true, forceNew: false });
    expect(String(body.idempotencyKey).length).toBeGreaterThan(8);
  });

  it('quem só lê não vê o botão de consulta nem a decisão', async () => {
    useAuthStore().me = me('MEMBER', { credit: ['read'] });
    routeGet(status(), [check]);
    const w = mount(DriverCreditCard, { props: { driverId: 'd1', hasCpf: true }, global: { stubs } });
    await flushPromises();
    expect(w.text()).not.toContain('Consultar Serasa');
    expect(w.text()).not.toContain('Decisão da locação');
  });

  it('sem credencial, desligada ou sem CPF: explica e não oferece consulta', async () => {
    useAuthStore().me = me('OWNER');
    routeGet(status({ connected: false, message: 'Serasa não configurada (SERASA_CLIENT_ID e SERASA_CLIENT_SECRET).' }), []);
    let w = mount(DriverCreditCard, { props: { driverId: 'd1', hasCpf: true }, global: { stubs } });
    await flushPromises();
    expect(w.text()).toContain('Serasa não configurada');
    expect(w.text()).not.toContain('Consultar Serasa');

    routeGet(status({ settings: { enabled: false, costPerQueryCents: null, monthlyLimit: null, reuseDays: 30, retentionDays: 90 } }), []);
    w = mount(DriverCreditCard, { props: { driverId: 'd1', hasCpf: true }, global: { stubs } });
    await flushPromises();
    expect(w.text()).toContain('desligada');

    routeGet(status(), []);
    w = mount(DriverCreditCard, { props: { driverId: 'd1', hasCpf: false }, global: { stubs } });
    await flushPromises();
    expect(w.text()).toContain('Cadastre o CPF');
    expect(w.text()).not.toContain('Consultar Serasa');
  });

  it('menu "Análise de crédito" só para quem tem o módulo', () => {
    const auth = useAuthStore();
    const item = navigation.find((n) => n.key === 'credit')!;
    auth.me = me('MEMBER', { drivers: ['read'] });
    expect(auth.hasAccess(item.module!)).toBe(false);
    auth.me = me('MEMBER', { credit: ['read'] });
    expect(auth.hasAccess(item.module!)).toBe(true);
  });
});
