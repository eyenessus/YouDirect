import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { FipeReportRow, MeResponse, VehicleFipe } from '@yudirect/contracts';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), delete: (...a: unknown[]) => del(...a) },
  ApiRequestError: class extends Error {},
}));
vi.mock('vue-router', () => ({
  RouterLink: defineComponent({ props: { to: [String, Object] }, setup: (p, { slots }) => () => h('a', { href: String(p.to) }, slots.default?.()) }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

import VehicleFipeCard from '@/features/vehicles/VehicleFipeCard.vue';
import FipeReportPage from '@/features/vehicles/FipeReportPage.vue';
import { useAuthStore } from '@/stores/auth';
import { navigation } from '@/components/layout/navigation';

const fipe: VehicleFipe = {
  link: { brandId: '21', modelId: '4828', yearId: '2022-1' },
  codeFipe: '001478-1',
  brandName: 'Fiat',
  modelName: 'Mobi Like 1.0',
  modelYear: 2022,
  fuel: 'Gasolina',
  referenceMonth: 'novembro de 2026',
  priceCents: 6235000,
  fetchedAt: '2026-11-11T12:00:00.000Z',
  history: [
    { referenceMonth: 'outubro de 2026', priceCents: 6300000 },
    { referenceMonth: 'novembro de 2026', priceCents: 6235000 },
  ],
};

function login(perms: Record<string, string[]>) {
  useAuthStore().me = { user: { id: 'u', name: 'T', email: 't@t.com' }, organization: { id: 'o', name: 'O', role: 'MEMBER', permissions: perms } } as unknown as MeResponse;
}

beforeEach(() => {
  setActivePinia(createPinia());
  get.mockReset();
  post.mockReset();
  del.mockReset();
});

describe('valor de mercado (FIPE)', () => {
  it('mostra o valor, a referência e o histórico mensal', () => {
    login({ vehicles: ['read', 'update'] });
    const w = mount(VehicleFipeCard, { props: { vehicleId: 'v'.repeat(24), fipe } });
    expect(w.text()).toContain('Fiat Mobi Like 1.0');
    expect(w.text()).toContain('001478-1');
    expect(w.text()).toContain('novembro de 2026');
    expect(w.text()).toContain('outubro de 2026');
  });

  it('sem vínculo convida a vincular; quem só pode ver não tem botões', () => {
    login({ vehicles: ['read'] });
    const w = mount(VehicleFipeCard, { props: { vehicleId: 'v'.repeat(24), fipe: null } });
    expect(w.text()).toContain('Vincule o veículo');
    expect(w.findAll('button')).toHaveLength(0);
  });

  it('vincula escolhendo marca, modelo e ano em cascata', async () => {
    login({ vehicles: ['read', 'update'] });
    get.mockImplementation(async (path: string) => {
      if (path === '/fipe/brands') return { data: [{ code: '21', name: 'Fiat' }] };
      if (path.endsWith('/models')) return { data: [{ code: '4828', name: 'Mobi Like 1.0' }] };
      return { data: [{ code: '2022-1', name: '2022 Gasolina' }] };
    });
    post.mockResolvedValue({ fipe });
    const w = mount(VehicleFipeCard, { props: { vehicleId: 'v'.repeat(24), fipe: null } });
    await w.findAll('button').find((b) => b.text() === 'Vincular à FIPE')!.trigger('click');
    await flushPromises();
    await w.findAll('select')[0]!.setValue('21');
    await flushPromises();
    expect(get).toHaveBeenCalledWith('/fipe/brands/21/models');
    await w.findAll('select')[1]!.setValue('4828');
    await flushPromises();
    expect(get).toHaveBeenCalledWith('/fipe/brands/21/models/4828/years');
    await w.findAll('select')[2]!.setValue('2022-1');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(post).toHaveBeenCalledWith(`/vehicles/${'v'.repeat(24)}/fipe`, { brandId: '21', modelId: '4828', yearId: '2022-1' });
    expect(w.emitted('saved')?.[0]).toEqual([fipe]);
  });

  it('atualiza e remove o vínculo', async () => {
    login({ vehicles: ['read', 'update'] });
    post.mockResolvedValue({ fipe });
    del.mockResolvedValue(undefined);
    const w = mount(VehicleFipeCard, { props: { vehicleId: 'v'.repeat(24), fipe } });
    await w.findAll('button').find((b) => b.text() === 'Atualizar')!.trigger('click');
    await flushPromises();
    expect(post).toHaveBeenCalledWith(`/vehicles/${'v'.repeat(24)}/fipe/refresh`, {});
    await w.findAll('button').find((b) => b.text() === 'Remover vínculo')!.trigger('click');
    await flushPromises();
    expect(del).toHaveBeenCalledWith(`/vehicles/${'v'.repeat(24)}/fipe`);
    expect(w.emitted('saved')?.at(-1)).toEqual([null]);
  });

  it('o relatório mostra variação, aluguel e rendimento, e traço quando falta dado', async () => {
    login({ vehicles: ['read'] });
    const row = (over: Partial<FipeReportRow>): FipeReportRow => ({
      vehicleId: 'a'.repeat(24),
      plate: 'ABC1D23',
      label: 'Fiat Mobi',
      purchaseDate: '2025-01-10',
      purchaseAmountCents: 8000000,
      fipePriceCents: 6235000,
      referenceMonth: 'novembro de 2026',
      changeVsPurchasePercent: -22.1,
      weeklyRentCents: 60000,
      annualYieldPercent: 50,
      ...over,
    });
    get.mockResolvedValue({ data: [row({}), row({ vehicleId: 'b'.repeat(24), plate: 'XYZ9K87', purchaseAmountCents: null, changeVsPurchasePercent: null, weeklyRentCents: null, annualYieldPercent: null })] });
    const w = mount(FipeReportPage);
    await flushPromises();
    expect(w.text()).toContain('-22,1%');
    expect(w.text()).toContain('50,0%');
    expect(w.text()).toContain('XYZ9K87');
    expect(w.text()).toContain('—');
  });

  it('o menu de Veículos tem o atalho Valor de mercado', () => {
    expect(navigation.find((n) => n.key === 'vehicles')!.children?.some((c) => c.to === '/dashboard/vehicles/fipe')).toBe(true);
  });
});
