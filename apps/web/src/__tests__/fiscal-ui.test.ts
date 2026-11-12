import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { FiscalNote, MeResponse, PendingFiscalPayment } from '@yudirect/contracts';

const get = vi.fn();
const post = vi.fn();
const downloadFile = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
  ApiRequestError: class extends Error {},
  downloadFile: (...a: unknown[]) => downloadFile(...a),
}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));

import FiscalPage from '@/features/finance/FiscalPage.vue';
import { useAuthStore } from '@/stores/auth';
import { navigation } from '@/components/layout/navigation';

const pendingRow = (over: Partial<PendingFiscalPayment> = {}): PendingFiscalPayment => ({
  paymentId: 'p'.repeat(24),
  paidAt: '2026-11-10',
  amountCents: 60000,
  description: 'Pagamento da locação - Contrato LOC-1',
  driverName: 'Maria Souza',
  method: 'PIX',
  ...over,
});
const note = (over: Partial<FiscalNote> = {}): FiscalNote => ({
  id: 'n'.repeat(24),
  paymentId: 'p'.repeat(24),
  number: 'NFS-1001',
  issuedOn: '2026-11-11',
  amountCents: 60000,
  url: 'https://nfe.exemplo/1001',
  notes: null,
  status: 'ISSUED',
  canceledReason: null,
  description: 'Pagamento da locação - Contrato LOC-1',
  driverName: 'Maria Souza',
  createdAt: '2026-11-11T12:00:00.000Z',
  ...over,
});

function login(perms: Record<string, string[]>) {
  useAuthStore().me = { user: { id: 'u', name: 'T', email: 't@t.com' }, organization: { id: 'o', name: 'O', role: 'MEMBER', permissions: perms } } as unknown as MeResponse;
}
function serve(pending: PendingFiscalPayment[], notes: FiscalNote[] = []) {
  get.mockImplementation(async (path: string) => {
    if (path === '/fiscal/pending') return { data: pending, totalCents: pending.reduce((s, p) => s + p.amountCents, 0) };
    return { data: notes };
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  get.mockReset();
  post.mockReset();
  downloadFile.mockReset();
  downloadFile.mockResolvedValue(undefined);
});

describe('notas fiscais e recibos (tela)', () => {
  it('avisa que o sistema não emite nota e lista os recebimentos sem nota com o total', async () => {
    login({ finance: ['read', 'create'] });
    serve([pendingRow(), pendingRow({ paymentId: 'q'.repeat(24), amountCents: 8000, description: 'KM excedente', driverName: 'João Lima' })]);
    const w = mount(FiscalPage);
    await flushPromises();
    expect(w.text()).toContain('não emite nota fiscal');
    expect(w.text()).toContain('2 recebimento(s) sem nota');
    expect(w.text()).toContain('680,00');
    expect(w.text()).toContain('João Lima');
  });

  it('baixa o recibo e exporta o CSV do período', async () => {
    login({ finance: ['read', 'create'] });
    serve([pendingRow()]);
    const w = mount(FiscalPage);
    await flushPromises();
    await w.findAll('button').find((b) => b.text() === 'Recibo')!.trigger('click');
    expect(downloadFile).toHaveBeenCalledWith(`/payments/${'p'.repeat(24)}/receipt.pdf`, 'recibo.pdf');
    await w.findAll('button').find((b) => b.text().startsWith('Exportar para o contador'))!.trigger('click');
    expect(downloadFile).toHaveBeenLastCalledWith('/fiscal/pending.csv', 'recebimentos-sem-nota.csv', expect.objectContaining({ from: expect.any(String), to: expect.any(String) }));
  });

  it('registra a nota com número, data e link', async () => {
    login({ finance: ['read', 'create'] });
    serve([pendingRow()]);
    post.mockResolvedValue({});
    const w = mount(FiscalPage);
    await flushPromises();
    await w.findAll('button').find((b) => b.text() === 'Registrar nota')!.trigger('click');
    const field = (label: string) => w.find(`#${w.findAll('label').find((l) => l.text().startsWith(label))!.attributes('for')}`);
    await field('Número da nota').setValue('NFS-77');
    await field('Link da nota').setValue('https://nfe.exemplo/77');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(post).toHaveBeenCalledWith('/fiscal/notes', expect.objectContaining({ paymentId: 'p'.repeat(24), number: 'NFS-77', url: 'https://nfe.exemplo/77' }));
  });

  it('quem só pode ver não registra nota, mas baixa o recibo', async () => {
    login({ finance: ['read'] });
    serve([pendingRow()]);
    const w = mount(FiscalPage);
    await flushPromises();
    expect(w.findAll('button').some((b) => b.text() === 'Registrar nota')).toBe(false);
    expect(w.findAll('button').some((b) => b.text() === 'Recibo')).toBe(true);
  });

  it('lista as notas registradas e cancela com motivo', async () => {
    login({ finance: ['read', 'create'] });
    serve([], [note(), note({ id: 'm'.repeat(24), number: 'NFS-9', status: 'CANCELED', canceledReason: 'Valor errado' })]);
    post.mockResolvedValue({});
    const w = mount(FiscalPage);
    await flushPromises();
    await w.findAll('button').find((b) => b.text() === 'Notas registradas')!.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('NFS-1001');
    expect(w.text()).toContain('Emitida');
    expect(w.text()).toContain('Cancelada');
    expect(w.text()).toContain('Valor errado');
    expect(w.find('a[href="https://nfe.exemplo/1001"]').attributes('rel')).toContain('noopener');
    // Só a nota emitida tem o botão de cancelar.
    expect(w.findAll('button').filter((b) => b.text() === 'Cancelar nota')).toHaveLength(1);
    await w.findAll('button').find((b) => b.text() === 'Cancelar nota')!.trigger('click');
    await w.find('form input').setValue('Emitida em duplicidade');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(post).toHaveBeenCalledWith(`/fiscal/notes/${'n'.repeat(24)}/cancel`, { reason: 'Emitida em duplicidade' });
  });

  it('o menu de Financeiro tem o atalho Notas fiscais', () => {
    expect(navigation.find((n) => n.key === 'finance')!.children?.some((c) => c.to === '/dashboard/finance/fiscal')).toBe(true);
  });
});
