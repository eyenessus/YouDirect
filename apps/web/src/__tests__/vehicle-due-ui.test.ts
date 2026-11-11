import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { VehicleDueItem } from '@yudirect/contracts';

const get = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => get(...a) },
  ApiRequestError: class extends Error {},
}));
vi.mock('vue-router', () => ({
  RouterLink: defineComponent({ props: { to: [String, Object] }, setup: (p, { slots }) => () => h('a', { href: String(p.to) }, slots.default?.()) }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

import VehicleDuePage from '@/features/vehicles/VehicleDuePage.vue';
import { navigation } from '@/components/layout/navigation';

const item = (over: Partial<VehicleDueItem>): VehicleDueItem => ({
  vehicleId: 'a'.repeat(24),
  plate: 'ABC1D23',
  label: 'Fiat Cronos',
  kind: 'IPVA',
  dueDate: '2026-11-20',
  daysLeft: 9,
  status: 'SOON',
  ...over,
});

beforeEach(() => {
  setActivePinia(createPinia());
  get.mockReset();
});

describe('vencimentos da frota (tela)', () => {
  it('lista os itens com a situação em português e o link para atualizar a data', async () => {
    get.mockResolvedValue({
      data: [item({ kind: 'IPVA', daysLeft: -2, status: 'OVERDUE', dueDate: '2026-11-09' }), item({ kind: 'LICENSING', daysLeft: 0 }), item({ kind: 'INSURANCE', daysLeft: 20 })],
    });
    const w = mount(VehicleDuePage);
    await flushPromises();
    expect(get).toHaveBeenCalledWith('/vehicles/due?withinDays=60');
    expect(w.text()).toContain('Venceu há 2 dia(s)');
    expect(w.text()).toContain('Vence hoje');
    expect(w.text()).toContain('Em 20 dia(s)');
    expect(w.text()).toContain('1 vencimento(s) em atraso');
    expect(w.text()).toContain('Licenciamento');
    expect(w.find('a[href="/dashboard/vehicles/' + 'a'.repeat(24) + '/edit"]').exists()).toBe(true);
  });

  it('mostra o estado vazio e refaz a busca ao trocar o tipo', async () => {
    get.mockResolvedValue({ data: [] });
    const w = mount(VehicleDuePage);
    await flushPromises();
    expect(w.text()).toContain('Nada vencendo');
    const seguro = w.findAll('button').find((b) => b.text() === 'Seguro')!;
    await seguro.trigger('click');
    await flushPromises();
    expect(get).toHaveBeenLastCalledWith('/vehicles/due?withinDays=60&kind=INSURANCE');
  });

  it('o menu de Veículos tem o atalho Vencimentos', () => {
    const vehicles = navigation.find((n) => n.key === 'vehicles')!;
    expect(vehicles.children?.some((c) => c.to === '/dashboard/vehicles/due')).toBe(true);
  });
});
