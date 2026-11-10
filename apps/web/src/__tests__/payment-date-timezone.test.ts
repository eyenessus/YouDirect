import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const AppModalStub = defineComponent({
  props: { open: Boolean, title: String, description: String },
  emits: ['close'],
  setup(props, { slots }) {
    return () => (props.open ? h('div', [slots.default?.(), slots.footer?.()]) : null);
  },
});

/**
 * Regressão (auditoria): o modal usava `new Date().toISOString()` (UTC). Depois das 21h em
 * São Paulo isso já é "amanhã" e a API rejeita pagamento com data futura.
 */
describe('data padrão da baixa respeita o fuso de negócio (America/Sao_Paulo)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    get.mockReset();
    post.mockReset();
    post.mockResolvedValue({});
    get.mockResolvedValue({ data: [{ id: 'b1', name: 'Conta', isDefault: true, active: true }] });
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const pay = async () => {
    const wrapper = mount(RegisterPaymentModal, {
      props: { open: false, kind: 'receivable', target: { id: 'r1', description: 'x', remainingCents: 5000 } },
      global: { stubs: { AppModal: AppModalStub } },
    });
    await wrapper.setProps({ open: true });
    await flushPromises();
    await wrapper.findAll('button').find((b) => b.text() === 'Confirmar')!.trigger('click');
    await flushPromises();
    return post.mock.calls[0]![1].paidAt as string;
  };

  it('23h30 em São Paulo (02h30 UTC do dia seguinte) continua sendo o dia de hoje', async () => {
    vi.setSystemTime(new Date('2026-11-11T02:30:00.000Z')); // 10/11/2026 23:30 em São Paulo
    expect(await pay()).toBe('2026-11-10');
  });

  it('00h30 em São Paulo (03h30 UTC) já é o novo dia', async () => {
    vi.setSystemTime(new Date('2026-11-11T03:30:00.000Z')); // 11/11/2026 00:30 em São Paulo
    expect(await pay()).toBe('2026-11-11');
  });
});
