import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();

const { FakeApiError } = vi.hoisted(() => ({
  FakeApiError: class extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
    fieldErrors() {
      return {};
    }
  },
}));

vi.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
  },
  ApiRequestError: FakeApiError,
}));
vi.mock('@/router', () => ({ router: { replace: vi.fn() } }));

import DriverPixModal from '@/features/driver-portal/DriverPixModal.vue';
import InspectionDamagesModal from '@/features/inspections/InspectionDamagesModal.vue';

const AppModalStub = defineComponent({
  props: { open: Boolean, title: String, description: String },
  emits: ['close'],
  setup(props, { slots }) {
    return () => (props.open ? h('div', { 'data-modal': props.title }, [slots.default?.(), slots.footer?.()]) : null);
  },
});
const stubs = { AppModal: AppModalStub };

const invoice = {
  key: '0123456789abcdef01234567:1',
  kind: 'RENT' as const,
  description: 'Semana 1',
  rentalNumber: 'LOC-2026-001',
  dueDate: '2026-11-10',
  amountCents: 60000,
  paidCents: 0,
  remainingCents: 60000,
  status: 'OPEN' as const,
};
const pending = {
  id: 'c1',
  receivableId: 'r1',
  description: 'Semana 1',
  amountCents: 60000,
  status: 'PENDING',
  qrCode: '00020126580014br.gov.bcb.pix0136fake',
  qrCodeBase64: 'iVBORw0KGgo=',
  ticketUrl: null,
  expiresAt: '2026-11-11T12:00:00.000Z',
  paidAt: null,
  createdAt: '2026-11-10T12:00:00.000Z',
};

beforeEach(() => {
  setActivePinia(createPinia());
  get.mockReset();
  post.mockReset();
  del.mockReset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('Pagar com Pix (Área do Motorista)', () => {
  it('mostra QR Code e código, e confirma quando o pagamento cai', async () => {
    post.mockResolvedValue(pending);
    get.mockResolvedValue({ ...pending, status: 'PAID', qrCode: null, qrCodeBase64: null });
    const w = mount(DriverPixModal, { props: { invoice, fallbackLink: null }, global: { stubs } });
    await flushPromises();
    expect(post).toHaveBeenCalledWith('/driver/invoices/pix', { key: invoice.key });
    expect(w.find('img[alt="QR Code do Pix"]').attributes('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(w.text()).toContain('br.gov.bcb.pix');

    vi.advanceTimersByTime(5000);
    await flushPromises();
    expect(get).toHaveBeenCalledWith('/driver/pix/c1');
    expect(w.text()).toContain('Pagamento confirmado');
    expect(w.emitted('paid')).toHaveLength(1);
  });

  it('sem Pix automático oferece o WhatsApp da locadora', async () => {
    post.mockRejectedValue(new FakeApiError(503, 'Cobrança Pix não configurada'));
    const w = mount(DriverPixModal, { props: { invoice, fallbackLink: 'https://wa.me/5511999990000' }, global: { stubs } });
    await flushPromises();
    expect(w.text()).toContain('não está disponível');
    expect(w.find('a[href="https://wa.me/5511999990000"]').exists()).toBe(true);
  });
});

describe('Cobrar avarias (vistoria)', () => {
  const prices = [
    { id: 'p1', name: 'Risco leve', category: 'Lataria', priceCents: 15000, active: true },
    { id: 'p2', name: 'Retrovisor', category: 'Peças', priceCents: 38000, active: true },
    { id: 'p3', name: 'Inativa', category: 'Peças', priceCents: 1, active: false },
  ];

  it('soma as quantidades marcadas, esconde itens inativos e envia a cobrança', async () => {
    get.mockImplementation((url: string) => Promise.resolve(url === '/damage-prices' ? { data: prices } : { data: [] }));
    post.mockResolvedValue({});
    const w = mount(InspectionDamagesModal, { props: { open: true, inspectionId: 'i1', plate: 'ABC1D23' }, global: { stubs } });
    await flushPromises();
    expect(w.text()).not.toContain('Inativa');
    await w.find('input[aria-label="Quantidade de Risco leve"]').setValue(2);
    await w.find('input[aria-label="Quantidade de Retrovisor"]').setValue(1);
    expect(w.text()).toMatch(/Cobrar R\$\s680,00/);
    const button = w.findAll('button').find((b) => b.text().startsWith('Cobrar'))!;
    await button.trigger('click');
    await flushPromises();
    expect(post).toHaveBeenCalledWith('/inspections/i1/damages', {
      items: [
        { damagePriceId: 'p1', quantity: 2, note: undefined },
        { damagePriceId: 'p2', quantity: 1, note: undefined },
      ],
      dueDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(w.emitted('charged')).toHaveLength(1);
  });

  it('com avarias já cobradas mostra o resumo e permite cancelar', async () => {
    get.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/damage-prices'
          ? { data: prices }
          : {
              data: [
                {
                  id: 'd1', inspectionId: 'i1', status: 'CHARGED', totalCents: 38000, createdAt: '2026-11-10T12:00:00.000Z',
                  items: [{ name: 'Retrovisor', category: 'Peças', quantity: 1, unitPriceCents: 38000, totalCents: 38000, note: null }],
                  receivable: { id: 'r1', status: 'OPEN', paidAmountCents: 0 },
                },
              ],
            },
      ),
    );
    del.mockResolvedValue({ ok: true });
    const w = mount(InspectionDamagesModal, { props: { open: true, inspectionId: 'i1', plate: 'ABC1D23' }, global: { stubs } });
    await flushPromises();
    expect(w.text()).toContain('Avarias já cobradas');
    await w.findAll('button').find((b) => b.text() === 'Cancelar cobrança')!.trigger('click');
    await flushPromises();
    expect(del).toHaveBeenCalledWith('/inspections/i1/damages');
  });
});
