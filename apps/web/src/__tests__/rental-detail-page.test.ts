import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { MeResponse } from '@yudirect/contracts';

const get = vi.fn();
const push = vi.fn();
const replace = vi.fn();
const route = vi.hoisted(() => ({ params: { id: 'r1' } as Record<string, string>, query: {} as Record<string, string> }));

vi.mock('@/lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a) }, ApiRequestError: class extends Error {} }));
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, replace, back: vi.fn() }),
  useRoute: () => route,
}));

import RentalDetailPage from '@/features/rentals/RentalDetailPage.vue';
import { useAuthStore } from '@/stores/auth';

const rental = {
  id: 'r1',
  rentalNumber: 'LOC-2026-003',
  vehicle: { id: 'v1', plate: 'EBR7G53', brand: 'VW', model: 'GOL MPI', year: 2023 },
  driver: { id: 'd1', fullName: 'ADRELINO JOSÉ DA SILVA', cpf: '07454426417', phone: '11957266325' },
  startDate: '2026-08-11',
  endDate: '2026-12-11',
  rentalType: 'WEEKLY',
  periodicAmountCents: 70000,
  depositCents: 150000,
  contractFile: null,
  notes: 'Obs de teste',
  status: 'ACTIVE',
};

const me = (permissions: Record<string, string[]>, role: 'OWNER' | 'MEMBER' = 'MEMBER') =>
  ({
    user: { id: 'u', name: 'Erik', email: 'e@x.test', phone: null, initials: 'E', browserNotificationsEnabled: false },
    organization: { id: 'o', name: 'FF', legalId: null, role, permissions },
    organizations: [{ id: 'o', name: 'FF', role }],
  }) as unknown as MeResponse;

const mountPage = async () => {
  get.mockResolvedValue(rental);
  const w = mount(RentalDetailPage, {
    global: { stubs: {
        RentalPaymentsTab: { template: '<div data-stub="pagamentos">aba pagamentos</div>' },
        RouterLink: { template: '<a><slot /></a>' },
      },
    },
  });
  await flushPromises();
  return w;
};

beforeEach(() => {
  setActivePinia(createPinia());
  [get, push, replace].forEach((f) => f.mockReset());
  route.query = {};
});

describe('página da locação', () => {
  it('abre com o título "Locação #LOC-…", a situação e as abas Detalhes, Pagamentos e Multas', async () => {
    useAuthStore().me = me({}, 'OWNER');
    const w = await mountPage();
    expect(w.text()).toContain('Locação #LOC-2026-003');
    expect(w.text()).toContain('Detalhes completos da locação');
    expect(w.text()).toContain('Ativa');
    const tabs = w.findAll('[role="tab"]').map((t) => t.text());
    expect(tabs).toEqual(['Detalhes', 'Pagamentos', 'Multas']);
    expect(get).toHaveBeenCalledWith('/rentals/r1');
  });

  it('por padrão mostra a aba Detalhes com veículo, motorista, período, valores e observações', async () => {
    useAuthStore().me = me({}, 'OWNER');
    const w = await mountPage();
    const text = w.text().replace(/\s+/g, ' ');
    expect(text).toContain('EBR7G53');
    expect(text).toContain('VW GOL MPI 2023');
    expect(text).toContain('ADRELINO JOSÉ DA SILVA');
    expect(text).toContain('11/08/2026');
    expect(text).toContain('11/12/2026');
    expect(text).toContain('R$ 700,00');
    expect(text).toContain('R$ 1.500,00');
    expect(text).toContain('Obs de teste');
    expect(w.find('[data-stub="pagamentos"]').exists()).toBe(false);
  });

  it('?tab=payments abre direto na aba Pagamentos (é para onde o botão do motorista leva)', async () => {
    useAuthStore().me = me({}, 'OWNER');
    route.query = { tab: 'payments' };
    const w = await mountPage();
    expect(w.find('[data-stub="pagamentos"]').exists()).toBe(true);
    expect(w.text()).not.toContain('Contrato e observações');
  });

  it('trocar de aba atualiza o endereço (?tab=) sem recarregar a página', async () => {
    useAuthStore().me = me({}, 'OWNER');
    const w = await mountPage();
    await w.findAll('[role="tab"]')[1]!.trigger('click');
    expect(replace).toHaveBeenCalledWith({ query: { tab: 'payments' } });
    expect(w.find('[data-stub="pagamentos"]').exists()).toBe(true);
  });

  it('quem não pode ler o financeiro não vê a aba Pagamentos (nem abrindo ?tab=payments)', async () => {
    useAuthStore().me = me({ rentals: ['read'] });
    route.query = { tab: 'payments' };
    const w = await mountPage();
    expect(w.findAll('[role="tab"]').map((t) => t.text())).toEqual(['Detalhes']);
    expect(w.find('[data-stub="pagamentos"]').exists()).toBe(false);
    expect(w.text()).toContain('Contrato e observações');
  });

  it('locação inexistente volta para a lista de locações', async () => {
    useAuthStore().me = me({}, 'OWNER');
    get.mockRejectedValue(new Error('404'));
    mount(RentalDetailPage, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    expect(replace).toHaveBeenCalledWith('/dashboard/rentals');
  });
});
