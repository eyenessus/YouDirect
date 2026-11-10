import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const get = vi.fn();
const post = vi.fn();
const push = vi.fn();

vi.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
  ApiRequestError: class extends Error {
    fieldErrors() {
      return {};
    }
  },
}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push }), useRoute: () => ({ params: {} }) }));

import PayableFormPage from '@/features/finance/PayableFormPage.vue';
import CurrencyInput from '@/components/ui/CurrencyInput.vue';

const stubs = { PageHeader: true, AppModal: true, RouterLink: true };

async function mountForm() {
  get.mockImplementation(async (url: string) => {
    if (url === '/expense-categories') return { data: [{ id: 'c1', label: 'Financiamento' }] };
    if (url === '/vehicles') return { data: [] };
    return { data: [{ id: 'b1', name: 'Conta', isDefault: true, active: true }] };
  });
  const wrapper = mount(PayableFormPage, { global: { stubs } });
  await flushPromises();
  return wrapper;
}

/** O AppCheckbox renderiza <input> e <label for> como irmãos: liga pelo id. */
const checkbox = (wrapper: Awaited<ReturnType<typeof mountForm>>, label: string) => {
  const forId = wrapper
    .findAll('label')
    .find((l) => l.text().includes(label))!
    .attributes('for')!;
  return wrapper.find(`input[id="${forId}"]`);
};

beforeEach(() => {
  setActivePinia(createPinia());
  get.mockReset();
  post.mockReset();
  push.mockReset();
  post.mockResolvedValue({});
});

describe('PayableFormPage — parcelamento', () => {
  it('"Parcelado" mostra número de parcelas e periodicidade e resume o total', async () => {
    const wrapper = await mountForm();
    expect(wrapper.text()).not.toContain('Número de parcelas');

    await checkbox(wrapper, 'Parcelado').setValue(true);
    expect(wrapper.text()).toContain('Número de parcelas');
    expect(wrapper.text()).toContain('Periodicidade');
    expect(wrapper.text()).toContain('Valor de cada parcela');

    wrapper.findComponent(CurrencyInput).vm.$emit('update:modelValue', 150000);
    await flushPromises();
    // 12 parcelas (padrão) de R$ 1.500,00 = R$ 18.000,00
    // \s cobre o espaco nao separavel que o Intl pt-BR usa entre "R$" e o valor
    const text = wrapper.text().replace(/\s+/g, ' ');
    expect(text).toContain('12 parcelas de R$ 1.500,00');
    expect(text).toContain('R$ 18.000,00');
  });

  it('recorrência e parcelamento são exclusivos', async () => {
    const wrapper = await mountForm();
    await checkbox(wrapper, 'Parcelado').setValue(true);
    await checkbox(wrapper, 'Conta Recorrente').setValue(true);
    expect((checkbox(wrapper, 'Parcelado').element as HTMLInputElement).checked).toBe(false);

    await checkbox(wrapper, 'Parcelado').setValue(true);
    expect((checkbox(wrapper, 'Conta Recorrente').element as HTMLInputElement).checked).toBe(false);
  });

  it('envia installments {count, frequency} e não envia quando não é parcelado', async () => {
    const wrapper = await mountForm();
    wrapper.findComponent(CurrencyInput).vm.$emit('update:modelValue', 150000);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(post.mock.calls[0]![0]).toBe('/payables');
    expect(post.mock.calls[0]![1].installments).toBeUndefined();

    post.mockClear();
    await checkbox(wrapper, 'Parcelado').setValue(true);
    await wrapper.find('input[type="number"]').setValue('48');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    const body = post.mock.calls[0]![1];
    expect(body.installments).toEqual({ count: 48, frequency: 'MONTHLY' });
    expect(body.recurring).toBe(false);
    expect(push).toHaveBeenCalledWith('/dashboard/finance/accounts-payable');
  });
});
