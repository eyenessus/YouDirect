import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Geofence, MeResponse, TrackedVehicle, Vehicle } from '@yudirect/contracts';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), delete: (...a: unknown[]) => del(...a) },
  ApiRequestError: class extends Error {},
}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));

import TrackingPage from '@/features/vehicles/TrackingPage.vue';
import { useAuthStore } from '@/stores/auth';
import { navigation } from '@/components/layout/navigation';

const vehicle = { id: 'a'.repeat(24), plate: 'ABC1D23', brand: 'Fiat', model: 'Mobi' } as Vehicle;
const tracked = (over: Partial<TrackedVehicle> = {}): TrackedVehicle => ({
  vehicleId: vehicle.id,
  plate: 'ABC1D23',
  label: 'Fiat Mobi',
  deviceId: 'IMEI-1',
  deviceLabel: null,
  driverName: 'Maria Souza',
  position: { lat: -23.55, lng: -46.63, at: '2026-11-11T12:00:00.000Z', speedKmh: 42, ignition: true, odometerKm: 1200 },
  minutesAgo: 5,
  insideAllowedArea: true,
  mapUrl: 'https://www.google.com/maps?q=-23.55,-46.63',
  ...over,
});

function login(role: 'OWNER' | 'MEMBER', perms: Record<string, string[]> = {}) {
  useAuthStore().me = { user: { id: 'u', name: 'T', email: 't@t.com' }, organization: { id: 'o', name: 'O', role, permissions: perms } } as unknown as MeResponse;
}
function serve(overview: TrackedVehicle[], zones: Geofence[] = [], configured = true) {
  get.mockImplementation(async (path: string) => {
    if (path === '/tracking/overview') return { data: overview };
    if (path === '/tracking/devices') return { data: [{ id: 'd'.repeat(24), vehicleId: vehicle.id, deviceId: 'IMEI-1', label: null }] };
    if (path === '/tracking/geofences') return { data: zones };
    if (path === '/tracking/token') return { configured, rotatedAt: configured ? '2026-11-01T12:00:00.000Z' : null, webhookUrl: 'https://yudirect.example/api/v1/webhooks/tracker' };
    return { data: [vehicle] };
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  get.mockReset();
  post.mockReset();
  del.mockReset();
});

describe('rastreamento (tela)', () => {
  it('mostra a última posição, o tempo, a área e o link do mapa', async () => {
    login('OWNER');
    serve([tracked(), tracked({ vehicleId: 'b'.repeat(24), plate: 'XYZ9K87', insideAllowedArea: false, minutesAgo: 3000, position: null, mapUrl: null }), tracked({ vehicleId: 'c'.repeat(24), plate: 'QQQ1Q11', insideAllowedArea: null, minutesAgo: null, position: null, mapUrl: null })]);
    const w = mount(TrackingPage);
    await flushPromises();
    expect(w.text()).toContain('há 5 min');
    expect(w.text()).toContain('42 km/h');
    expect(w.text()).toContain('Dentro');
    expect(w.text()).toContain('Fora da área');
    expect(w.text()).toContain('há 2 dias');
    expect(w.text()).toContain('Nunca reportou');
    expect(w.text()).toContain('Sem áreas');
    const link = w.find('a[href^="https://www.google.com/maps"]');
    expect(link.attributes('rel')).toContain('noopener');
  });

  it('mostra o endereço do webhook e gera o token uma vez, só para dono ou administrador', async () => {
    login('OWNER');
    serve([tracked()]);
    post.mockResolvedValue({ token: 'ytk_abc123' });
    const w = mount(TrackingPage);
    await flushPromises();
    expect(w.text()).toContain('https://yudirect.example/api/v1/webhooks/tracker');
    expect(w.text()).toContain('não é mostrado de novo');
    await w.findAll('button').find((b) => b.text().startsWith('Gerar novo token'))!.trigger('click');
    await flushPromises();
    expect(post).toHaveBeenCalledWith('/tracking/token', {});
    expect(w.text()).toContain('ytk_abc123');
    expect(w.text()).toContain('não aparecerá novamente');
  });

  it('quem não é dono nem administrador não vê o botão do token', async () => {
    login('MEMBER', { vehicles: ['read', 'update'] });
    serve([tracked()]);
    const w = mount(TrackingPage);
    await flushPromises();
    expect(w.findAll('button').some((b) => b.text().includes('token'))).toBe(false);
  });

  it('cadastra rastreador e área enviando os valores certos', async () => {
    login('OWNER');
    serve([tracked()]);
    post.mockResolvedValue({});
    const w = mount(TrackingPage);
    await flushPromises();
    const input = (label: string) => w.find(`#${w.findAll('label').find((l) => l.text().startsWith(label))!.attributes('for')}`);

    const forms = w.findAll('form');
    await forms[0]!.find('select').setValue(vehicle.id);
    await input('Código do rastreador').setValue('IMEI-9');
    await forms[0]!.trigger('submit');
    await flushPromises();
    expect(post).toHaveBeenCalledWith('/tracking/devices', { vehicleId: vehicle.id, deviceId: 'IMEI-9', label: undefined });

    await input('Nome').setValue('São Paulo capital');
    await input('Raio').setValue('20000');
    await input('Latitude').setValue('-23,5505');
    await input('Longitude').setValue('-46,6333');
    await forms[1]!.trigger('submit');
    await flushPromises();
    expect(post).toHaveBeenLastCalledWith('/tracking/geofences', { name: 'São Paulo capital', lat: -23.5505, lng: -46.6333, radiusM: 20000 });
  });

  it('remove rastreador e área', async () => {
    login('OWNER');
    serve([tracked()], [{ id: 'z'.repeat(24), name: 'Capital', lat: 0, lng: 0, radiusM: 20000 }]);
    del.mockResolvedValue(undefined);
    const w = mount(TrackingPage);
    await flushPromises();
    const removes = w.findAll('button').filter((b) => b.text() === 'Remover');
    expect(removes).toHaveLength(2);
    await removes[0]!.trigger('click');
    await removes[1]!.trigger('click');
    expect(del).toHaveBeenCalledWith(`/tracking/devices/${'d'.repeat(24)}`);
    expect(del).toHaveBeenCalledWith(`/tracking/geofences/${'z'.repeat(24)}`);
  });

  it('o menu de Veículos tem o atalho Rastreamento', () => {
    expect(navigation.find((n) => n.key === 'vehicles')!.children?.some((c) => c.to === '/dashboard/vehicles/tracking')).toBe(true);
  });
});
