import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import {
  driverStatusLabels,
  inspectionStatusLabels,
  invoiceStatusLabels,
  maintenanceStatusLabels,
  payableStatusLabels,
  receivableStatusLabels,
  rentalStatusLabels,
  vehicleStatusLabels,
} from '@yudirect/contracts';
import { statusTone } from '@/lib/status';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import MetricCard from '@/components/ui/MetricCard.vue';
import EmptyState from '@/components/ui/EmptyState.vue';

/** Nenhum status pode cair sem rótulo ou sem cor definida. */
describe('mapa de status', () => {
  const pairs = [
    ['vehicle', vehicleStatusLabels, statusTone.vehicle],
    ['driver', driverStatusLabels, statusTone.driver],
    ['rental', rentalStatusLabels, statusTone.rental],
    ['maintenance', maintenanceStatusLabels, statusTone.maintenance],
    ['inspection', inspectionStatusLabels, statusTone.inspection],
    ['payable', payableStatusLabels, statusTone.payable],
    ['receivable', receivableStatusLabels, statusTone.receivable],
    ['invoice', invoiceStatusLabels, statusTone.invoice],
  ] as const;

  it.each(pairs)('%s tem rótulo e tom para cada status', (_name, labels, tones) => {
    const labelKeys = Object.keys(labels).sort();
    const toneKeys = Object.keys(tones).sort();
    expect(toneKeys).toEqual(labelKeys);
    for (const key of labelKeys) {
      expect(String(labels[key as keyof typeof labels])).not.toBe('');
      expect(['blue', 'green', 'red', 'amber', 'slate']).toContain(tones[key as keyof typeof tones]);
    }
  });

  it('usa os tons observados nas capturas', () => {
    expect(statusTone.vehicle.RENTED).toBe('blue');
    expect(statusTone.payable.PAID).toBe('blue');
    expect(statusTone.receivable.OVERDUE).toBe('red');
    expect(statusTone.inspection.APPROVED).toBe('green');
    expect(statusTone.severity.CRITICAL).toBe('red');
  });
});

describe('StatusBadge', () => {
  it('renderiza o rótulo e aplica a cor do tom', () => {
    const wrapper = mount(StatusBadge, { props: { label: 'Locado', tone: 'blue' } });
    expect(wrapper.text()).toBe('Locado');
    expect(wrapper.classes().join(' ')).toContain('bg-brand-500');
  });

  it('variante suave usa fundo claro', () => {
    const wrapper = mount(StatusBadge, { props: { label: 'Vencida', tone: 'red', solid: false } });
    expect(wrapper.classes().join(' ')).toContain('border');
  });
});

describe('MetricCard', () => {
  it('mostra valor e rodapé observado ("R$ 15.703,00 em out")', () => {
    const wrapper = mount(MetricCard, {
      props: { label: 'Faturamento', value: 'R$ 5.603,00', footnote: 'R$ 15.703,00 em out' },
    });
    expect(wrapper.text()).toContain('Faturamento');
    expect(wrapper.text()).toContain('R$ 5.603,00');
    expect(wrapper.text()).toContain('R$ 15.703,00 em out');
  });

  it('no painel mostra a variação como inteiro, em cinza e sem ícone', () => {
    const wrapper = mount(MetricCard, {
      props: { label: 'Faturamento', value: 'R$ 5.603,00', deltaPercent: -64.3 },
    });
    // A referência (pág. 014) escreve "-64% do mês passado" em #6B7280.
    expect(wrapper.text()).toContain('-64%');
    expect(wrapper.text()).not.toContain('-64,3%');
    expect(wrapper.text()).toContain('do mês passado');
    expect(wrapper.find('svg').exists()).toBe(false);
    expect(wrapper.html()).not.toContain('--c-negative');
  });

  it('variação nula aparece como "+0%", como na referência', () => {
    const wrapper = mount(MetricCard, {
      props: { label: 'Total de Veículos', value: '6', deltaPercent: 0 },
    });
    expect(wrapper.text()).toContain('+0% do mês passado');
  });

  it('exibe a variação como pílula no modo financeiro', () => {
    const wrapper = mount(MetricCard, {
      props: { label: 'Lucro', value: 'R$ 3.708,55', deltaPercent: -39.8, pill: true },
    });
    expect(wrapper.text()).toContain('-39,8%');
    expect(wrapper.text()).not.toContain('do mês passado');
  });

  it('declara a ausência de base de comparação em vez de inventar 0%', () => {
    const wrapper = mount(MetricCard, {
      props: { label: 'Margem', value: '66,2%', deltaPercent: null },
    });
    expect(wrapper.text()).toContain('Sem base de comparação');
    expect(wrapper.text()).not.toContain('0,0%');
  });

  it('para despesas, queda é tratada como resultado bom', () => {
    const wrapper = mount(MetricCard, {
      props: { label: 'Despesas', value: 'R$ 1.894,45', deltaPercent: -80.1, invertDelta: true, pill: true },
    });
    expect(wrapper.html()).toContain('--c-positive');
  });
});

describe('EmptyState', () => {
  it('explica a ausência de dados sem simular conteúdo', () => {
    const wrapper = mount(EmptyState, {
      props: { title: 'Nenhuma conta a pagar', message: 'Cadastre a primeira conta.' },
    });
    expect(wrapper.text()).toContain('Nenhuma conta a pagar');
    expect(wrapper.text()).toContain('Cadastre a primeira conta.');
  });
});
