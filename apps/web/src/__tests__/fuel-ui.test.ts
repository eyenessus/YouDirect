import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { FuelLog, FuelSummary, MeResponse, Vehicle } from '@yudirect/contracts';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), delete: vi.fn() },
  ApiRequestError: class extends Error {
    fieldErrors() {
      return {};
    }
  },
}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));

import FuelPage from '@/features/vehicles/FuelPage.vue';
import { useAuthStore } from '@/stores/auth';
import { navigation } from '@/components/layout/navigation';

const vehicle = { id: 'a'.repeat(24), plate: 'ABC1D23', brand: 'Fiat', model: 'Mobi' } as Vehicle;
const summary: FuelSummary = { vehicleId: vehicle.id, plate: 'ABC1D23', label: 'Fiat Mobi', fills: 3, liters: 90, totalCents: 54000, distanceKm: 500, kmPerLiter: 10, costPerKmCents: 60 };
const log: FuelLog = {
  id: 'l'.repeat(24),
  vehicle: { id: vehicle.id, plate: 'ABC1D23', label: 'Fiat Mobi' },
  driver: { id: 'd'.repeat(24), fullName: 'Maria Souza' },
  date: '2026-11-10',
  fuelType: 'ETHANOL',
  liters: 30,
  totalCents: 12000,
  pricePerLiterCents: 400,
  odometerKm: 1500,
  fullTank: false,
  station: null,
  notes: null,
  createdAt: '2026-11-10T12:00:00.000Z',
};

function login(perms: Record<string, string[]>) {
  useAuthStore().me = { user: { id: 'u', name: 'T', email: 't@t.com' }, organization: { id: 'o', name: 'O', role: 'MEMBER', permissions: perms } } as unknown as MeResponse;
}
function serve(summaries: FuelSummary[], logs: FuelLog[]) {
  get.mockImplementation(async (path: string) => {
    if (path.startsWith('/vehicles')) return { data: [vehicle] };
    if (path.startsWith('/fuel-logs/summary')) return { data: summaries };
    return { data: logs };
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  get.mockReset();
  post.mockReset();
});

describe('abastecimento (tela)', () => {
  it('mostra consumo e custo por km, e a lista marca o abastecimento parcial', async () => {
    login({ vehicles: ['read', 'update'] });
    serve([summary], [log]);
    const w = mount(FuelPage);
    await flushPromises();
    expect(w.text()).toContain('ABC1D23');
    expect(w.text()).toContain('500');
    expect(w.text()).toContain('Etanol (parcial)');
    expect(w.text()).toContain('Maria Souza');
  });

  it('sem abastecimento mostra o estado vazio', async () => {
    login({ vehicles: ['read', 'update'] });
    serve([], []);
    const w = mount(FuelPage);
    await flushPromises();
    expect(w.text()).toContain('Sem abastecimentos');
  });

  it('envia o registro com litros em vírgula, valor em centavos e hodômetro numérico', async () => {
    login({ vehicles: ['read', 'update'] });
    serve([], []);
    post.mockResolvedValue({});
    const w = mount(FuelPage);
    await flushPromises();
    await w.find('select').setValue(vehicle.id);
    const byLabel = (text: string) => w.find(`#${w.findAll('label').find((l) => l.text().startsWith(text))!.attributes('for')}`);
    await byLabel('Litros').setValue('38,5');
    await byLabel('Hodômetro').setValue('1250');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(post).toHaveBeenCalledTimes(1);
    const body = post.mock.calls[0]![1] as Record<string, unknown>;
    expect(post.mock.calls[0]![0]).toBe('/fuel-logs');
    expect(body).toMatchObject({ vehicleId: vehicle.id, liters: 38.5, odometerKm: 1250, fuelType: 'GASOLINE', fullTank: true });
  });

  it('quem só pode ver não tem o formulário', async () => {
    login({ vehicles: ['read'] });
    serve([summary], []);
    const w = mount(FuelPage);
    await flushPromises();
    expect(w.find('form').exists()).toBe(false);
  });

  it('o menu de Veículos tem o atalho Abastecimento', () => {
    expect(navigation.find((n) => n.key === 'vehicles')!.children?.some((c) => c.to === '/dashboard/vehicles/fuel')).toBe(true);
  });
});
