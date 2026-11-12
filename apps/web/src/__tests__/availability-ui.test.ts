import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { AvailabilityRow, MeResponse, Rental, VehicleSwap } from '@yudirect/contracts';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
  ApiRequestError: class extends Error {},
}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));

import AvailabilityPage from '@/features/vehicles/AvailabilityPage.vue';
import { useAuthStore } from '@/stores/auth';
import { navigation } from '@/components/layout/navigation';

const row = (over: Partial<AvailabilityRow>): AvailabilityRow => ({
  vehicleId: 'a'.repeat(24),
  plate: 'AAA1A11',
  label: 'Fiat Mobi',
  status: 'AVAILABLE',
  driverName: null,
  rentalNumber: null,
  rentalEndsOn: null,
  asReplacementFor: null,
  replacedBy: null,
  openMaintenance: 0,
  openClaims: 0,
  usableAsReplacement: true,
  ...over,
});
const rental = { id: 'r'.repeat(24), rentalNumber: 'LOC-1', driver: { fullName: 'Maria Souza' }, vehicle: { plate: 'BBB2B22' } } as unknown as Rental;
const swap: VehicleSwap = {
  id: 's'.repeat(24),
  status: 'ACTIVE',
  reason: 'MAINTENANCE',
  rental: { id: 'x'.repeat(24), rentalNumber: 'LOC-9' },
  driver: { id: 'd'.repeat(24), fullName: 'João Lima' },
  original: { id: 'o'.repeat(24), plate: 'OOO1O11', label: 'Fiat Argo' },
  replacement: { id: 'p'.repeat(24), plate: 'PPP1P11', label: 'Fiat Mobi' },
  claimId: null,
  startedOn: '2026-11-10',
  endedOn: null,
  notes: null,
  createdAt: '2026-11-10T12:00:00.000Z',
};

function login(perms: Record<string, string[]>) {
  useAuthStore().me = { user: { id: 'u', name: 'T', email: 't@t.com' }, organization: { id: 'o', name: 'O', role: 'MEMBER', permissions: perms } } as unknown as MeResponse;
}
function serve(rows: AvailabilityRow[], swaps: VehicleSwap[], rentals: Rental[]) {
  get.mockImplementation(async (path: string) => {
    if (path.startsWith('/vehicles/availability')) return { data: rows };
    if (path.startsWith('/vehicle-swaps')) return { data: swaps };
    return { data: rentals };
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  get.mockReset();
  post.mockReset();
});

describe('disponibilidade e carro reserva (tela)', () => {
  it('mostra a frota com situação, observações e quem pode ser reserva', async () => {
    login({ vehicles: ['read'], rentals: ['read', 'update'] });
    serve(
      [
        row({}),
        row({ vehicleId: 'b'.repeat(24), plate: 'BBB2B22', status: 'RENTED', driverName: 'Maria Souza', rentalNumber: 'LOC-1', rentalEndsOn: '2026-12-01', usableAsReplacement: false, openClaims: 1 }),
        row({ vehicleId: 'c'.repeat(24), plate: 'CCC3C33', status: 'RENTED', usableAsReplacement: false, asReplacementFor: 'OOO1O11' }),
      ],
      [],
      [rental],
    );
    const w = mount(AvailabilityPage);
    await flushPromises();
    expect(w.text()).toContain('Disponível');
    expect(w.text()).toContain('Pode ser reserva');
    expect(w.text()).toContain('Maria Souza');
    expect(w.text()).toContain('1 sinistro(s) em aberto');
    expect(w.text()).toContain('Reserva do OOO1O11');
  });

  it('só oferece como reserva os veículos que podem servir', async () => {
    login({ vehicles: ['read'], rentals: ['read', 'update'] });
    serve([row({}), row({ vehicleId: 'b'.repeat(24), plate: 'BBB2B22', status: 'RENTED', usableAsReplacement: false })], [], [rental]);
    const w = mount(AvailabilityPage);
    await flushPromises();
    const reserve = w.findAll('select')[1]!;
    const labels = reserve.findAll('option').map((o) => o.text());
    expect(labels.some((l) => l.includes('AAA1A11'))).toBe(true);
    expect(labels.some((l) => l.includes('BBB2B22'))).toBe(false);
  });

  it('entrega o reserva enviando locação, veículo e motivo', async () => {
    login({ vehicles: ['read'], rentals: ['read', 'update'] });
    serve([row({})], [], [rental]);
    post.mockResolvedValue({});
    const w = mount(AvailabilityPage);
    await flushPromises();
    const selects = w.findAll('select');
    await selects[0]!.setValue(rental.id);
    await selects[1]!.setValue('a'.repeat(24));
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(post).toHaveBeenCalledWith(`/rentals/${rental.id}/swap`, { replacementVehicleId: 'a'.repeat(24), reason: 'MAINTENANCE' });
  });

  it('devolve a troca com ou sem a volta do original', async () => {
    login({ vehicles: ['read'], rentals: ['read', 'update'] });
    serve([row({})], [swap], []);
    post.mockResolvedValue({});
    const w = mount(AvailabilityPage);
    await flushPromises();
    expect(w.text()).toContain('LOC-9');
    expect(w.text()).toContain('PPP1P11');
    await w.findAll('button').find((b) => b.text().startsWith('Devolver e voltar'))!.trigger('click');
    expect(post).toHaveBeenCalledWith(`/vehicle-swaps/${swap.id}/end`, { originalReturned: true });
    await w.findAll('button').find((b) => b.text().startsWith('Devolver (original'))!.trigger('click');
    expect(post).toHaveBeenLastCalledWith(`/vehicle-swaps/${swap.id}/end`, { originalReturned: false });
  });

  it('quem não pode editar locações não vê o formulário nem os botões', async () => {
    login({ vehicles: ['read'], rentals: ['read'] });
    serve([row({})], [swap], []);
    const w = mount(AvailabilityPage);
    await flushPromises();
    expect(w.find('form').exists()).toBe(false);
    expect(w.findAll('button').some((b) => b.text().startsWith('Devolver'))).toBe(false);
  });

  it('o menu de Veículos tem o atalho Disponibilidade', () => {
    expect(navigation.find((n) => n.key === 'vehicles')!.children?.some((c) => c.to === '/dashboard/vehicles/availability')).toBe(true);
  });
});
