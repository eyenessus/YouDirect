import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { Claim, MeResponse } from '@yudirect/contracts';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a) },
  ApiRequestError: class extends Error {},
  uploadFile: vi.fn(),
}));
vi.mock('vue-router', () => ({
  RouterLink: defineComponent({ props: { to: [String, Object] }, setup: (p, { slots }) => () => h('a', { href: String(p.to) }, slots.default?.()) }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useRoute: () => ({ params: { id: 'c'.repeat(24) }, query: {} }),
}));

import ClaimListPage from '@/features/claims/ClaimListPage.vue';
import ClaimDetailPage from '@/features/claims/ClaimDetailPage.vue';
import { useAuthStore } from '@/stores/auth';
import { navigation } from '@/components/layout/navigation';

const claim = (over: Partial<Claim> = {}): Claim => ({
  id: 'c'.repeat(24),
  claimNumber: 'SIN-2026-001',
  status: 'OPEN',
  kind: 'COLLISION',
  fault: 'DRIVER',
  occurredOn: '2026-11-10',
  location: null,
  description: 'Colisão na traseira',
  policeReportNumber: 'BO-1',
  insurerClaimNumber: null,
  deductibleCents: 150000,
  estimatedCostCents: null,
  finalCostCents: null,
  vehicle: { id: 'a'.repeat(24), plate: 'ABC1D23', label: 'Fiat Cronos' },
  driver: { id: 'b'.repeat(24), fullName: 'Maria Souza' },
  rental: { id: 'd'.repeat(24), rentalNumber: 'LOC-2026-002' },
  files: [],
  receivable: null,
  history: [{ at: '2026-11-10T12:00:00.000Z', action: 'created', detail: 'Colisão em 10/11/2026' }],
  version: 1,
  createdAt: '2026-11-10T12:00:00.000Z',
  updatedAt: '2026-11-10T12:00:00.000Z',
  ...over,
});

function login(perms: Record<string, string[]>) {
  const auth = useAuthStore();
  auth.me = {
    user: { id: 'u', name: 'Teste', email: 't@t.com' },
    organization: { id: 'o', name: 'Org', role: 'MEMBER', permissions: perms },
  } as unknown as MeResponse;
}

beforeEach(() => {
  setActivePinia(createPinia());
  get.mockReset();
  post.mockReset();
  patch.mockReset();
});

describe('sinistros (telas)', () => {
  it('a lista mostra número, veículo, motorista e a situação em português', async () => {
    login({ claims: ['read', 'create'] });
    get.mockResolvedValue({ data: [claim()] });
    const w = mount(ClaimListPage);
    await flushPromises();
    expect(w.text()).toContain('SIN-2026-001');
    expect(w.text()).toContain('ABC1D23');
    expect(w.text()).toContain('Maria Souza');
    expect(w.text()).toContain('Colisão');
    expect(w.text()).toContain('Aberto');
    expect(w.find('a[href="/dashboard/claims/new"]').exists()).toBe(true);
  });

  it('quem não pode cadastrar não vê o botão de registrar', async () => {
    login({ claims: ['read'] });
    get.mockResolvedValue({ data: [] });
    const w = mount(ClaimListPage);
    await flushPromises();
    expect(w.text()).toContain('Nenhum sinistro');
    expect(w.find('a[href="/dashboard/claims/new"]').exists()).toBe(false);
  });

  it('o detalhe oferece só as próximas situações e cobra a franquia enviando a versão', async () => {
    login({ claims: ['read', 'update', 'pay'] });
    get.mockResolvedValue(claim());
    post.mockResolvedValue({ claim: claim({ version: 2, receivable: { id: 'r'.repeat(24), status: 'OPEN', grossAmountCents: 150000, paidAmountCents: 0 } }), alreadyCharged: false });
    const w = mount(ClaimDetailPage);
    await flushPromises();
    const labels = w.findAll('button').map((b) => b.text());
    expect(labels).toContain('Passar para: Em análise (seguradora)');
    expect(labels).toContain('Cancelar sinistro');
    expect(labels).not.toContain('Passar para: Aberto');

    await w.findAll('button').find((b) => b.text() === 'Cobrar motorista')!.trigger('click');
    await flushPromises();
    expect(post).toHaveBeenCalledWith(`/claims/${'c'.repeat(24)}/charge`, { version: 1, amountCents: 150000, dueDate: undefined });
    expect(w.text()).toContain('lançada em Contas a Receber');
    expect(w.findAll('button').some((b) => b.text() === 'Cobrar motorista')).toBe(false);
  });

  it('culpa de terceiro não permite cobrar e explica o motivo', async () => {
    login({ claims: ['read', 'update', 'pay'] });
    get.mockResolvedValue(claim({ fault: 'THIRD_PARTY' }));
    const w = mount(ClaimDetailPage);
    await flushPromises();
    expect(w.text()).toContain('A culpa é de terceiro');
    expect(w.findAll('button').some((b) => b.text() === 'Cobrar motorista')).toBe(false);
  });

  it('sinistro encerrado não tem ações de andamento', async () => {
    login({ claims: ['read', 'update', 'pay'] });
    get.mockResolvedValue(claim({ status: 'CLOSED' }));
    const w = mount(ClaimDetailPage);
    await flushPromises();
    expect(w.findAll('button').some((b) => b.text().startsWith('Passar para'))).toBe(false);
    expect(w.text()).toContain('Encerrado');
  });

  it('o menu tem Sinistros ligado ao módulo claims', () => {
    const item = navigation.find((n) => n.key === 'claims')!;
    expect(item.module).toBe('claims');
    expect(item.children?.map((c) => c.to)).toEqual(['/dashboard/claims', '/dashboard/claims/new']);
  });
});
