import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

const get = vi.fn();
const post = vi.fn();

vi.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
  ApiRequestError: class extends Error {
    fieldErrors() {
      return {};
    }
  },
}));

import LaunchPaymentDialog from '@/features/finance/LaunchPaymentDialog.vue';
import RegisterPaymentModal from '@/features/finance/RegisterPaymentModal.vue';

const AppModalStub = defineComponent({
  props: { open: Boolean, title: String, description: String, size: String },
  emits: ['close'],
  setup(props, { slots }) {
    return () => (props.open ? h('div', [slots.default?.(), slots.footer?.()]) : null);
  },
});
const stubs = { AppModal: AppModalStub };

const receivable = {
  id: 'r1',
  description: 'Locação LOC-2026-007',
  rental: { id: 'rent1', rentalNumber: 'LOC-2026-007' },
  driver: { id: 'd1', fullName: 'Fulano', cpf: null },
  grossAmountCents: 280000,
  paidAmountCents: 70000,
  remainingCents: 210000,
  dueDate: '2026-11-08',
  paymentMethod: null,
  status: 'OVERDUE',
  createdAt: '2026-11-01T00:00:00.000Z',
};

const week = (number: number, paid: number, status: string, due: string) => ({
  number,
  dueDate: due,
  amountCents: 70000,
  paidCents: paid,
  remainingCents: 70000 - paid,
  status,
});

const schedule = {
  rentalId: 'rent1',
  rentalNumber: 'LOC-2026-007',
  receivableId: 'r1',
  rentalType: 'WEEKLY',
  weeks: [
    week(1, 70000, 'PAID', '2026-11-08'),
    week(2, 0, 'OVERDUE', '2026-11-15'),
    week(3, 20000, 'PARTIAL', '2026-11-22'),
    week(4, 0, 'OPEN', '2026-11-29'),
  ],
  totals: { amountCents: 280000, paidCents: 90000, remainingCents: 190000 },
};

async function openDialog() {
  get.mockImplementation(async (url: string) => {
    if (url === '/receivables') return { data: [receivable] };
    if (url === '/rentals/rent1/payment-schedule') return schedule;
    return { data: [] };
  });
  const wrapper = mount(LaunchPaymentDialog, { props: { open: false, driverId: 'd1' }, global: { stubs } });
  await wrapper.setProps({ open: true });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  get.mockReset();
  post.mockReset();
  post.mockResolvedValue({});
});

describe('LaunchPaymentDialog — cronograma semanal', () => {
  it('busca o cronograma da locação e mostra uma linha por semana com a situação', async () => {
    const wrapper = await openDialog();
    expect(get.mock.calls.some(([url]) => url === '/rentals/rent1/payment-schedule')).toBe(true);

    const rows = wrapper.findAll('tbody tr');
    expect(rows).toHaveLength(4);
    expect(rows[0]!.text()).toContain('Paga');
    expect(rows[1]!.text()).toContain('Atrasada');
    expect(rows[2]!.text()).toContain('Parcial');
    expect(rows[3]!.text()).toContain('Em aberto');
  });

  it('só semanas com saldo têm "Dar baixa" (a semana paga não)', async () => {
    const wrapper = await openDialog();
    const rows = wrapper.findAll('tbody tr');
    expect(rows[0]!.findAll('button')).toHaveLength(0);
    for (const i of [1, 2, 3]) expect(rows[i]!.findAll('button')).toHaveLength(1);
  });

  it('"Dar baixa" na semana 3 sugere o ACUMULADO pendente das semanas 1 a 3', async () => {
    const wrapper = await openDialog();
    await wrapper.findAll('tbody tr')[2]!.find('button').trigger('click');
    await flushPromises();

    const modal = wrapper.findComponent(RegisterPaymentModal);
    expect(modal.props('open')).toBe(true);
    // semana 1 paga (0) + semana 2 (70000) + semana 3 (50000) = 120000
    expect(modal.props('suggestedAmountCents')).toBe(120000);
    expect(modal.props('target')).toMatchObject({ id: 'r1', remainingCents: 210000 });
    expect(modal.props('hint')).toContain('semana 3');
  });

  it('"Dar baixa" na primeira semana em aberto sugere só o valor dela, sem aviso de acumulado', async () => {
    const wrapper = await openDialog();
    await wrapper.findAll('tbody tr')[1]!.find('button').trigger('click');
    await flushPromises();
    const modal = wrapper.findComponent(RegisterPaymentModal);
    expect(modal.props('suggestedAmountCents')).toBe(70000);
  });

  it('"Pagar valor livre" continua sugerindo o saldo total do contrato', async () => {
    const wrapper = await openDialog();
    await wrapper.findAll('button').find((b) => b.text() === 'Pagar valor livre')!.trigger('click');
    await flushPromises();
    expect(wrapper.findComponent(RegisterPaymentModal).props('suggestedAmountCents')).toBe(210000);
  });

  it('sem cronograma (locação legada) a conta ainda pode ser paga pelo valor livre', async () => {
    get.mockImplementation(async (url: string) => {
      if (url === '/receivables') return { data: [receivable] };
      if (url === '/rentals/rent1/payment-schedule') return { ...schedule, receivableId: null, weeks: [] };
      return { data: [] };
    });
    const wrapper = mount(LaunchPaymentDialog, { props: { open: false, driverId: 'd1' }, global: { stubs } });
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(wrapper.findAll('tbody tr')).toHaveLength(0);
    expect(wrapper.text()).toContain('Pagar valor livre');
  });

  it('erro ao buscar o cronograma não derruba a lista de contas', async () => {
    get.mockImplementation(async (url: string) => {
      if (url === '/receivables') return { data: [receivable] };
      throw new Error('falhou');
    });
    const wrapper = mount(LaunchPaymentDialog, { props: { open: false, driverId: 'd1' }, global: { stubs } });
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(wrapper.text()).toContain('Locação LOC-2026-007');
  });
});

describe('RegisterPaymentModal — valor sugerido', () => {
  it('pré-preenche com o valor sugerido em vez do saldo total e envia esse valor', async () => {
    get.mockResolvedValue({ data: [{ id: 'b1', name: 'Conta', isDefault: true, active: true }] });
    const wrapper = mount(RegisterPaymentModal, {
      props: {
        open: false,
        kind: 'receivable',
        target: { id: 'r1', description: 'x', remainingCents: 210000 },
        suggestedAmountCents: 120000,
        hint: 'Valor acumulado até a semana 3',
      },
      global: { stubs },
    });
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(wrapper.text()).toContain('Valor acumulado até a semana 3');

    await wrapper.findAll('button').find((b) => b.text() === 'Confirmar')!.trigger('click');
    await flushPromises();
    expect(post.mock.calls[0]![1].amountCents).toBe(120000);
  });
});
