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

/** O modal real usa Teleport/foco; aqui só interessa o conteúdo quando aberto. */
const AppModalStub = defineComponent({
  props: { open: Boolean, title: String, description: String },
  emits: ['close'],
  setup(props, { slots }) {
    return () =>
      props.open ? h('div', { 'data-modal': props.title }, [slots.default?.(), slots.footer?.()]) : null;
  },
});
const stubs = { AppModal: AppModalStub };

const receivable = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  description: 'Locação LOC-2026-001',
  rental: { id: 'rent1', rentalNumber: 'LOC-2026-001' },
  driver: { id: 'd1', fullName: 'Fulano', cpf: null },
  grossAmountCents: 100000,
  paidAmountCents: 0,
  remainingCents: 100000,
  dueDate: '2026-11-20',
  paymentMethod: null,
  status: 'OPEN',
  createdAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  setActivePinia(createPinia());
  get.mockReset();
  post.mockReset();
  post.mockResolvedValue({});
});

describe('LaunchPaymentDialog', () => {
  it('busca só as contas em aberto do motorista ao abrir', async () => {
    get.mockResolvedValue({ data: [receivable()] });
    const wrapper = mount(LaunchPaymentDialog, {
      props: { open: false, driverId: 'd1' },
      global: { stubs },
    });
    await wrapper.setProps({ open: true });
    await flushPromises();

    const call = get.mock.calls.find(([url]) => url === '/receivables')!;
    expect(call[1].query).toMatchObject({ driverId: 'd1', openOnly: 'true' });
    expect(wrapper.text()).toContain('Locação LOC-2026-001');
    expect(wrapper.text()).toContain('Pagar');
  });

  it('busca por locação quando recebe rentalId', async () => {
    get.mockResolvedValue({ data: [receivable()] });
    const wrapper = mount(LaunchPaymentDialog, {
      props: { open: false, rentalId: 'rent1' },
      global: { stubs },
    });
    await wrapper.setProps({ open: true });
    await flushPromises();
    const call = get.mock.calls.find(([url]) => url === '/receivables')!;
    expect(call[1].query.rentalId).toBe('rent1');
    expect(call[1].query.driverId).toBeUndefined();
  });

  it('não lista contas já quitadas e mostra aviso quando não há nada a receber', async () => {
    get.mockResolvedValue({ data: [receivable({ remainingCents: 0, status: 'PAID' })] });
    const wrapper = mount(LaunchPaymentDialog, {
      props: { open: false, driverId: 'd1' },
      global: { stubs },
    });
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(wrapper.text()).toContain('Nenhuma conta a receber em aberto');
    expect(wrapper.text()).not.toContain('Locação LOC-2026-001');
  });

  it('"Pagar" abre o modal de recebimento com a conta escolhida e o saldo pendente', async () => {
    get.mockResolvedValue({ data: [receivable({ remainingCents: 65000 })] });
    const wrapper = mount(LaunchPaymentDialog, {
      props: { open: false, driverId: 'd1' },
      global: { stubs },
    });
    await wrapper.setProps({ open: true });
    await flushPromises();

    const payButton = wrapper.findAll('button').find((b) => b.text() === 'Pagar')!;
    await payButton.trigger('click');
    await flushPromises();

    const modal = wrapper.findComponent(RegisterPaymentModal);
    expect(modal.props('open')).toBe(true);
    expect(modal.props('kind')).toBe('receivable');
    expect(modal.props('target')).toEqual({
      id: 'r1',
      description: 'Locação LOC-2026-001',
      remainingCents: 65000,
    });
  });
});

describe('RegisterPaymentModal — chave de idempotência', () => {
  const bank = { id: 'b1', name: 'Conta Principal', isDefault: true, active: true };

  const mountModal = async () => {
    get.mockResolvedValue({ data: [bank] });
    const wrapper = mount(RegisterPaymentModal, {
      props: { open: false, kind: 'receivable', target: { id: 'r1', description: 'x', remainingCents: 5000 } },
      global: { stubs },
    });
    return wrapper;
  };

  const openAndConfirm = async (wrapper: Awaited<ReturnType<typeof mountModal>>) => {
    await wrapper.setProps({ open: true });
    await flushPromises();
    await wrapper.findAll('button').find((b) => b.text() === 'Confirmar')!.trigger('click');
    await flushPromises();
  };

  it('reenvio dentro da mesma abertura usa a MESMA chave; nova abertura usa chave nova', async () => {
    const wrapper = await mountModal();

    await openAndConfirm(wrapper);
    expect(post).toHaveBeenCalledTimes(1);
    const firstKey = post.mock.calls[0]![2].headers['idempotency-key'] as string;
    expect(firstKey).toMatch(/^receivable-r1-/);

    // Fecha e abre de novo (mesmo valor e mesma data): precisa ser outro pagamento.
    await wrapper.setProps({ open: false });
    await openAndConfirm(wrapper);
    expect(post).toHaveBeenCalledTimes(2);
    const secondKey = post.mock.calls[1]![2].headers['idempotency-key'] as string;
    expect(secondKey).not.toBe(firstKey);
  });

  it('envia valor, data, método e conta bancária corretos para o endpoint de recebimento', async () => {
    const wrapper = await mountModal();
    await openAndConfirm(wrapper);

    const [url, body] = post.mock.calls[0]!;
    expect(url).toBe('/receivables/r1/payments');
    expect(body).toMatchObject({ amountCents: 5000, method: 'PIX', bankAccountId: 'b1' });
    expect(body.paidAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(wrapper.emitted('saved')).toHaveLength(1);
  });

  it('sem conta bancária ativa não envia nada', async () => {
    get.mockResolvedValue({ data: [] });
    const wrapper = mount(RegisterPaymentModal, {
      props: { open: false, kind: 'receivable', target: { id: 'r1', description: 'x', remainingCents: 5000 } },
      global: { stubs },
    });
    await wrapper.setProps({ open: true });
    await flushPromises();
    await wrapper.findAll('button').find((b) => b.text() === 'Confirmar')!.trigger('click');
    await flushPromises();
    expect(post).not.toHaveBeenCalled();
  });
});
