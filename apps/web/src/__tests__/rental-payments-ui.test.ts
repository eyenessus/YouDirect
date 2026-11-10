import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { MeResponse, RentalPaymentsView } from '@yudirect/contracts';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();
const push = vi.fn();
const replace = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
    delete: (...a: unknown[]) => del(...a),
  },
  ApiRequestError: class extends Error {
    fieldErrors() {
      return {};
    }
  },
}));
vi.mock('vue-router', () => ({
  useRouter: () => ({ push, replace, back: vi.fn() }),
  useRoute: () => ({ params: { id: 'd1' }, query: {} }),
}));

import RentalPaymentForm from '@/features/rentals/RentalPaymentForm.vue';
import RentalPaymentsTab from '@/features/rentals/RentalPaymentsTab.vue';
import DriverDetailPage from '@/features/drivers/DriverDetailPage.vue';
import { useAuthStore } from '@/stores/auth';

const AppModalStub = defineComponent({
  props: { open: Boolean, title: String, description: String, size: String },
  emits: ['close'],
  setup(props, { slots }) {
    return () => (props.open ? h('div', { 'data-modal': props.title }, [slots.default?.(), slots.footer?.()]) : null);
  },
});

const me = (permissions: Record<string, string[]>, role: 'OWNER' | 'MEMBER' = 'MEMBER'): MeResponse =>
  ({
    user: { id: 'u', name: 'Erik', email: 'e@x.test', phone: null, initials: 'E', browserNotificationsEnabled: false },
    organization: { id: 'o', name: 'FF', legalId: null, role, permissions },
    organizations: [{ id: 'o', name: 'FF', role }],
  }) as unknown as MeResponse;

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  receiptNumber: 'INV-2026-031',
  category: 'EXTRA_KM',
  description: 'KM Excedente - Contrato LOC-2026-003',
  amountCents: 5000,
  expectedDate: '2026-08-10',
  method: 'PIX',
  status: 'PAID',
  paidAt: '2026-08-10',
  notes: null,
  ...over,
});

const viewOf = (entries: unknown[] = [], over: Record<string, unknown> = {}): RentalPaymentsView =>
  ({
    rentalId: 'r1',
    rentalNumber: 'LOC-2026-003',
    rentalStatus: 'ACTIVE',
    summary: { totalCents: 360000, paidCents: 0, pendingCents: 360000, depositCents: 150000 },
    entries,
    ...over,
  }) as unknown as RentalPaymentsView;

beforeEach(() => {
  document.body.innerHTML = '';
  setActivePinia(createPinia());
  [get, post, patch, del, push, replace].forEach((f) => f.mockReset());
});

/* --------------------------- formulário "Adicionar Pagamento" --------------------------- */
describe('RentalPaymentForm', () => {
  const mountForm = (props: Record<string, unknown> = {}) =>
    mount(RentalPaymentForm, { props: { rentalId: 'r1', mode: 'create', ...props } });
  const dates = (w: ReturnType<typeof mountForm>) => w.findAll('input[type="date"]');
  const checkbox = (w: ReturnType<typeof mountForm>) => w.find('input[type="checkbox"]');

  it('mostra Categoria, Valor, Data Prevista, "Já foi pago?" e Observação; datas VAZIAS (o dono define)', () => {
    const w = mountForm();
    expect(w.text()).toContain('Adicionar Pagamento');
    for (const label of ['Categoria', 'Valor', 'Data Prevista', 'Já foi pago?', 'Observação']) {
      expect(w.text()).toContain(label);
    }
    expect(dates(w)).toHaveLength(1);
    expect((dates(w)[0]!.element as HTMLInputElement).value).toBe('');
    const options = w.findAll('select option').map((o) => o.text());
    expect(options).toEqual(['Pagamento da Locação', 'KM Excedente']);
  });

  it('"Já foi pago?" revela Data do Pagamento e Forma de Pagamento (também vazia, sem data automática)', async () => {
    const w = mountForm();
    expect(w.text()).not.toContain('Data do Pagamento');
    await checkbox(w).setValue(true);
    expect(w.text()).toContain('Data do Pagamento');
    expect(w.text()).toContain('Forma de Pagamento');
    expect(dates(w)).toHaveLength(2);
    expect((dates(w)[1]!.element as HTMLInputElement).value).toBe('');
    await checkbox(w).setValue(false);
    expect(w.text()).not.toContain('Data do Pagamento');
  });

  it('sem valor e sem data prevista não envia e acusa os campos obrigatórios', async () => {
    const w = mountForm();
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(post).not.toHaveBeenCalled();
    expect(w.text()).toContain('Informe um valor maior que zero');
    expect(w.text()).toContain('Informe a data prevista');
  });

  it('marcado como pago, a data do pagamento passa a ser obrigatória', async () => {
    const w = mountForm();
    await checkbox(w).setValue(true);
    await dates(w)[0]!.setValue('2026-11-09');
    w.findComponent({ name: 'CurrencyInput' }).vm.$emit('update:modelValue', 5000);
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(post).not.toHaveBeenCalled();
    expect(w.text()).toContain('Informe a data do pagamento');
  });

  it('salva PENDENTE: envia categoria, valor, data prevista e a chave de idempotência', async () => {
    post.mockResolvedValue(viewOf([entry({ status: 'PENDING', paidAt: null, method: null })]));
    const w = mountForm();
    await w.find('select').setValue('EXTRA_KM');
    w.findComponent({ name: 'CurrencyInput' }).vm.$emit('update:modelValue', 5000);
    await dates(w)[0]!.setValue('2026-08-10');
    await w.find('form').trigger('submit');
    await flushPromises();

    const [url, body, opts] = post.mock.calls[0]!;
    expect(url).toBe('/rentals/r1/payments');
    expect(body).toMatchObject({ category: 'EXTRA_KM', amountCents: 5000, expectedDate: '2026-08-10', alreadyPaid: false });
    expect(body.paidAt).toBeUndefined();
    expect(opts.headers['idempotency-key']).toMatch(/[0-9a-f-]{20,}/);
    expect(w.emitted('saved')).toHaveLength(1);
  });

  it('salva JÁ PAGO: envia as duas datas e a forma de pagamento exatamente como o dono informou', async () => {
    post.mockResolvedValue(viewOf([entry()]));
    const w = mountForm();
    await checkbox(w).setValue(true);
    w.findComponent({ name: 'CurrencyInput' }).vm.$emit('update:modelValue', 5000);
    await dates(w)[0]!.setValue('2026-11-09');
    await dates(w)[1]!.setValue('2026-11-10');
    await w.findAll('select')[1]!.setValue('BOLETO');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(post.mock.calls[0]![1]).toMatchObject({
      expectedDate: '2026-11-09',
      paidAt: '2026-11-10',
      method: 'BOLETO',
      alreadyPaid: true,
    });
  });

  it('editar: vem preenchido, a categoria fica travada e usa PATCH', async () => {
    patch.mockResolvedValue(viewOf([entry({ amountCents: 7500, status: 'PENDING', paidAt: null })]));
    const w = mountForm({ mode: 'edit', entry: entry({ status: 'PENDING', paidAt: null, method: null }) });
    expect(w.text()).toContain('Editar Pagamento');
    expect((w.find('select').element as HTMLSelectElement).disabled).toBe(true);
    expect(w.find('input[type="checkbox"]').exists()).toBe(false);
    w.findComponent({ name: 'CurrencyInput' }).vm.$emit('update:modelValue', 7500);
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(patch.mock.calls[0]![0]).toBe('/rentals/r1/payments/e1');
    expect(patch.mock.calls[0]![1]).toMatchObject({ amountCents: 7500, expectedDate: '2026-08-10' });
  });

  it('marcar como pago: só pede Data do Pagamento e Forma, e usa o endpoint /pay', async () => {
    post.mockResolvedValue(viewOf([entry()]));
    const w = mountForm({ mode: 'pay', entry: entry({ status: 'PENDING', paidAt: null, method: null }) });
    expect(w.text()).toContain('Marcar como pago');
    expect(w.text()).not.toContain('Data Prevista');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(post).not.toHaveBeenCalled();
    expect(w.text()).toContain('Informe a data do pagamento');

    await dates(w)[0]!.setValue('2026-11-10');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(post.mock.calls[0]![0]).toBe('/rentals/r1/payments/e1/pay');
    expect(post.mock.calls[0]![1]).toEqual({ paidAt: '2026-11-10', method: 'PIX' });
  });
});

/* --------------------------- aba Pagamentos --------------------------- */
describe('RentalPaymentsTab', () => {
  const owner = () => {
    useAuthStore().me = me({}, 'OWNER');
  };
  const mountTab = async (view: RentalPaymentsView) => {
    get.mockResolvedValue(view);
    const w = mount(RentalPaymentsTab, { props: { rentalId: 'r1' }, attachTo: document.body });
    await flushPromises();
    return w;
  };

  it('mostra os 4 cartões do vídeo: Total (sem caução), Pago, Pendente e Caução (valor separado)', async () => {
    owner();
    const w = await mountTab(viewOf([], { summary: { totalCents: 365000, paidCents: 5000, pendingCents: 360000, depositCents: 150000 } }));
    const card = (name: string) => w.find(`[data-card="${name}"]`).text().replace(/\s+/g, ' ');
    expect(card('total')).toContain('Valor Total');
    expect(card('total')).toContain('R$ 3.650,00');
    expect(card('total')).toContain('Valor total da locação (sem caução)');
    expect(card('paid')).toContain('Valor Pago');
    expect(card('paid')).toContain('R$ 50,00');
    expect(card('paid')).toContain('Pagamentos realizados');
    expect(card('pending')).toContain('Valor Pendente');
    expect(card('pending')).toContain('R$ 3.600,00');
    expect(card('pending')).toContain('A receber');
    expect(card('deposit')).toContain('Caução');
    expect(card('deposit')).toContain('R$ 1.500,00');
    expect(card('deposit')).toContain('Valor separado');
    expect(w.text()).toContain('Utilize esta área para registrar os pagamentos feitos pelo motorista');
  });

  it('sem pagamentos mostra o estado vazio do vídeo e o botão Adicionar Pagamento', async () => {
    owner();
    const w = await mountTab(viewOf([]));
    expect(w.text()).toContain('Lista de Pagamentos');
    expect(w.text()).toContain('Nenhum pagamento registrado. Adicione um pagamento para começar');
    expect(w.findAll('button').some((b) => b.text().includes('Adicionar Pagamento'))).toBe(true);
  });

  it('a lista traz as colunas do Frota One e a linha com recibo, categoria, datas e situação', async () => {
    owner();
    const w = await mountTab(viewOf([entry()]));
    const heads = w.findAll('th').map((t) => t.text());
    for (const h of ['Nº Recibo', 'Categoria', 'Descrição', 'Valor', 'Dt. Prevista', 'Forma Pgto.', 'Situação', 'Dt. Pagamento', 'Ações']) {
      expect(heads).toContain(h);
    }
    const row = w.find('tbody tr').text().replace(/\s+/g, ' ');
    expect(row).toContain('INV-2026-031');
    expect(row).toContain('KM Excedente');
    expect(row).toContain('KM Excedente - Contrato LOC-2026-003');
    expect(row).toContain('10/08/2026');
    expect(row).toContain('PIX');
    expect(row).toContain('Pago');
    expect(w.text()).toContain('Mostrando 1 de 1 pagamentos');
  });

  it('"Adicionar Pagamento" abre o formulário na própria página; "Fechar" o esconde', async () => {
    owner();
    const w = await mountTab(viewOf([]));
    await w.findAll('button').find((b) => b.text().includes('Adicionar Pagamento'))!.trigger('click');
    expect(w.find('form').exists()).toBe(true);
    await w.findAll('button').find((b) => b.text() === 'Fechar')!.trigger('click');
    expect(w.find('form').exists()).toBe(false);
  });

  it('a busca consulta a API com o termo digitado', async () => {
    owner();
    const w = await mountTab(viewOf([entry()]));
    get.mockClear();
    get.mockResolvedValue(viewOf([]));
    const input = w.find('input[type="search"], input[type="text"]');
    await input.setValue('KM');
    await new Promise((r) => setTimeout(r, 400));
    await flushPromises();
    expect(get.mock.calls.some(([url, opts]) => url === '/rentals/r1/payments' && opts?.query?.q === 'KM')).toBe(true);
  });

  it('sem permissão de pagar não há botão de adicionar nem menu de ações de escrita', async () => {
    useAuthStore().me = me({ finance: ['read'] });
    const w = await mountTab(viewOf([entry({ status: 'PENDING', paidAt: null, method: null })]));
    expect(w.findAll('button').some((b) => b.text().includes('Adicionar Pagamento'))).toBe(false);
    expect(w.find('[aria-label^="Ações do pagamento"]').exists()).toBe(false);
  });

  it('locação encerrada não oferece Adicionar Pagamento', async () => {
    owner();
    const w = await mountTab(viewOf([], { rentalStatus: 'FINISHED' }));
    expect(w.findAll('button').some((b) => b.text().includes('Adicionar Pagamento'))).toBe(false);
    expect(w.text()).toContain('não está ativa');
  });

  const openMenu = async (w: Awaited<ReturnType<typeof mountTab>>) => {
    await w.find('[aria-label^="Ações do pagamento"]').trigger('click');
    await flushPromises();
    return Array.from(document.body.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent!.trim());
  };

  it('menu ⋮ de um pagamento PENDENTE: Marcar como pago, Editar e Excluir', async () => {
    owner();
    const w = await mountTab(viewOf([entry({ status: 'PENDING', paidAt: null, method: null })]));
    const items = await openMenu(w);
    expect(items).toEqual(['Marcar como pago', 'Editar', 'Excluir']);
  });

  it('menu ⋮ de um pagamento PAGO: só Excluir (que estorna)', async () => {
    owner();
    const w = await mountTab(viewOf([entry()]));
    const items = await openMenu(w);
    expect(items).toEqual(['Excluir']);
  });
});

/* --------------------------- botão "Lançar pagamento" do motorista --------------------------- */
describe('DriverDetailPage — Lançar pagamento', () => {
  const driver = {
    id: 'd1',
    fullName: 'ADRELINO JOSÉ DA SILVA',
    cpf: '07454426417',
    rg: null,
    birthDate: '1980-01-01',
    email: null,
    phone: '11957266325',
    cnhNumber: null,
    cnhCategory: null,
    cnhExpiry: null,
    address: {},
    documents: {},
    status: 'ACTIVE',
    createdAt: '2026-08-11T00:00:00.000Z',
    activeRentalsCount: 1,
  };
  const rental = (id: string, number: string) => ({
    id,
    rentalNumber: number,
    vehicle: { plate: 'EBR7G53', brand: 'VW', model: 'GOL' },
  });

  const mountDriver = async (rentals: unknown[]) => {
    useAuthStore().me = me({}, 'OWNER');
    get.mockImplementation(async (url: string) => (url === '/rentals' ? { data: rentals } : driver));
    const w = mount(DriverDetailPage, {
      global: { stubs: { AppModal: AppModalStub, WhatsappConsentCard: true, RouterLink: true, PageHeader: false } },
    });
    await flushPromises();
    return w;
  };
  const click = async (w: Awaited<ReturnType<typeof mountDriver>>) => {
    await w.findAll('button').find((b) => b.text().includes('Lançar pagamento'))!.trigger('click');
    await flushPromises();
  };

  it('com UMA locação ativa vai direto para a aba Pagamentos dela', async () => {
    const w = await mountDriver([rental('r1', 'LOC-2026-007')]);
    await click(w);
    const call = get.mock.calls.find(([url]) => url === '/rentals')!;
    expect(call[1].query).toMatchObject({ driverId: 'd1', status: 'ACTIVE' });
    expect(push).toHaveBeenCalledWith({ path: '/dashboard/rentals/r1', query: { tab: 'payments' } });
  });

  it('com VÁRIAS locações ativas pergunta qual e só então navega', async () => {
    const w = await mountDriver([rental('r1', 'LOC-2026-007'), rental('r2', 'LOC-2026-008')]);
    await click(w);
    expect(push).not.toHaveBeenCalled();
    expect(w.text()).toContain('LOC-2026-007');
    expect(w.text()).toContain('LOC-2026-008');
    await w.findAll('button').filter((b) => b.text() === 'Abrir pagamentos')[1]!.trigger('click');
    expect(push).toHaveBeenCalledWith({ path: '/dashboard/rentals/r2', query: { tab: 'payments' } });
  });

  it('sem locação ativa não navega (avisa o dono)', async () => {
    const w = await mountDriver([]);
    await click(w);
    expect(push).not.toHaveBeenCalled();
  });

  it('o botão some para quem não pode pagar', async () => {
    useAuthStore().me = me({ drivers: ['read'] });
    get.mockResolvedValue(driver);
    const w = mount(DriverDetailPage, {
      global: { stubs: { AppModal: AppModalStub, WhatsappConsentCard: true, RouterLink: true } },
    });
    await flushPromises();
    expect(w.findAll('button').some((b) => b.text().includes('Lançar pagamento'))).toBe(false);
  });
});
