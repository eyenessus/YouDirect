import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { formatCentsBRL } from '@frotaone/contracts';
import CurrencyInput from '@/components/ui/CurrencyInput.vue';

/**
 * T20 — o campo monetário é apenas máscara de apresentação: o valor
 * trafega sempre em centavos inteiros, sem ponto flutuante.
 */
describe('CurrencyInput', () => {
  it('formata a digitação progressiva e emite centavos inteiros', async () => {
    const wrapper = mount(CurrencyInput, { props: { modelValue: 0 } });
    const input = wrapper.get('input');

    await input.setValue('1');
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([1]);
    expect(input.element.value).toBe('R$ 0,01');

    await input.setValue('172045');
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([172045]);
    expect(input.element.value).toBe('R$ 1.720,45');
  });

  it('ignora caracteres não numéricos digitados pelo usuário', async () => {
    const wrapper = mount(CurrencyInput, { props: { modelValue: 0 } });
    const input = wrapper.get('input');
    await input.setValue('R$ 5.603,00abc');
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([560300]);
    expect(input.element.value).toBe('R$ 5.603,00');
  });

  it('volta a vazio quando o campo é apagado (não emite NaN)', async () => {
    const wrapper = mount(CurrencyInput, { props: { modelValue: 12345 } });
    const input = wrapper.get('input');
    expect(input.element.value).toBe('R$ 123,45');
    await input.setValue('');
    expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([0]);
    expect(input.element.value).toBe('');
  });

  it('reflete alterações externas do modelo', async () => {
    const wrapper = mount(CurrencyInput, { props: { modelValue: 0 } });
    await wrapper.setProps({ modelValue: 189445 });
    expect(wrapper.get('input').element.value).toBe('R$ 1.894,45');
    expect(formatCentsBRL(189445).replace(/\u00a0/g, ' ')).toBe('R$ 1.894,45');
  });

  it('marca aria-invalid quando inválido', () => {
    const wrapper = mount(CurrencyInput, { props: { modelValue: 0, invalid: true } });
    expect(wrapper.get('input').attributes('aria-invalid')).toBe('true');
  });
});
