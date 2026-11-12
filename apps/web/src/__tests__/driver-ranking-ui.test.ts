import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { DriverRankingRow } from '@yudirect/contracts';

const get = vi.fn();
vi.mock('@/lib/api', () => ({ api: { get: (...a: unknown[]) => get(...a) }, ApiRequestError: class extends Error {} }));
vi.mock('vue-router', () => ({
  RouterLink: defineComponent({ props: { to: [String, Object] }, setup: (p, { slots }) => () => h('a', { href: String(p.to) }, slots.default?.()) }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

import DriverRankingPage from '@/features/drivers/DriverRankingPage.vue';
import { navigation } from '@/components/layout/navigation';

const row = (over: Partial<DriverRankingRow>): DriverRankingRow => ({
  driverId: 'a'.repeat(24),
  fullName: 'Maria Souza',
  plate: 'ABC1D23',
  score: 120,
  levelCode: 'INTERMEDIARIO',
  levelName: 'Intermediário',
  attention: false,
  computedAt: '2026-11-11T10:00:00.000Z',
  ...over,
});

beforeEach(() => {
  setActivePinia(createPinia());
  get.mockReset();
});

describe('ranking de motoristas (tela)', () => {
  it('mostra pontos, nível e marca quem precisa de atenção', async () => {
    get.mockResolvedValue({ data: [row({ driverId: 'b'.repeat(24), fullName: 'João Lima', score: 5, levelName: 'Inicial', attention: true }), row({})] });
    const w = mount(DriverRankingPage);
    await flushPromises();
    expect(w.text()).toContain('João Lima');
    expect(w.text()).toContain('Inicial · atenção');
    expect(w.text()).toContain('1 motorista(s) com pontuação baixa');
    expect(w.find(`a[href="/dashboard/drivers/${'b'.repeat(24)}"]`).exists()).toBe(true);
  });

  it('o filtro mostra só quem precisa de atenção', async () => {
    get.mockResolvedValue({ data: [row({ driverId: 'b'.repeat(24), fullName: 'João Lima', score: 5, attention: true }), row({})] });
    const w = mount(DriverRankingPage);
    await flushPromises();
    await w.find('input[type="checkbox"]').setValue(true);
    expect(w.text()).toContain('João Lima');
    expect(w.text()).not.toContain('Maria Souza');
  });

  it('sem motoristas mostra o estado vazio e o menu tem o atalho', async () => {
    get.mockResolvedValue({ data: [] });
    const w = mount(DriverRankingPage);
    await flushPromises();
    expect(w.text()).toContain('Nenhum motorista');
    expect(navigation.find((n) => n.key === 'drivers')!.children?.some((c) => c.to === '/dashboard/drivers/ranking')).toBe(true);
  });
});
