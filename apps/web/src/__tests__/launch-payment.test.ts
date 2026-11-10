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

beforeEach(() => {
  setActivePinia(createPinia());
  get.mockReset();
  post.mockReset();
  post.mockResolvedValue({});
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
