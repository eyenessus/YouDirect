import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

const get = vi.fn();
const post = vi.fn();
const replace = vi.fn();
const reset = vi.fn();

const { FakeApiError } = vi.hoisted(() => ({
  FakeApiError: class extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
  ApiRequestError: FakeApiError,
}));
vi.mock('vue-router', () => ({
  useRouter: () => ({ replace }),
  useRoute: () => ({ query: {} }),
  RouterLink: defineComponent({ setup: (_, { slots }) => () => h('a', slots.default?.()) }),
}));

import LoginPage from '@/features/auth/LoginPage.vue';

/** Turnstile falso: expõe reset() e deixa o teste emitir o token. */
const TurnstileStub = defineComponent({
  props: { siteKey: String, action: String },
  emits: ['token', 'error'],
  setup(props, { emit, expose }) {
    expose({ reset });
    return () =>
      h('button', { type: 'button', 'data-testid': 'solve', 'data-sitekey': props.siteKey, 'data-action': props.action, onClick: () => emit('token', 'TOKEN-123') }, 'resolver');
  },
});

async function mountLogin() {
  const w = mount(LoginPage, { global: { stubs: { TurnstileWidget: TurnstileStub } } });
  await flushPromises();
  await w.find('input[type="email"]').setValue('erik@ffveiculos.example.com');
  await w.find('input[type="password"]').setValue('Senha@123');
  return w;
}

const submitButton = (w: Awaited<ReturnType<typeof mountLogin>>) => w.findAll('button').find((b) => b.text() === 'Entrar')!;

beforeEach(() => {
  setActivePinia(createPinia());
  get.mockReset();
  post.mockReset();
  replace.mockReset();
  reset.mockReset();
});

describe('login com Cloudflare Turnstile', () => {
  it('ligado: mostra o widget com a chave pública e só libera "Entrar" após resolver', async () => {
    get.mockResolvedValue({ captcha: { provider: 'turnstile', siteKey: '0x4AAA-site', action: 'login' } });
    post.mockResolvedValue({ ok: true });
    const w = await mountLogin();
    const widget = w.find('[data-testid="solve"]');
    expect(widget.attributes('data-sitekey')).toBe('0x4AAA-site');
    expect(widget.attributes('data-action')).toBe('login');
    expect(submitButton(w).attributes('disabled')).toBeDefined();

    await w.find('form').trigger('submit');
    expect(post).not.toHaveBeenCalled();

    await widget.trigger('click');
    expect(submitButton(w).attributes('disabled')).toBeUndefined();
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(post).toHaveBeenCalledWith('/auth/login', { email: 'erik@ffveiculos.example.com', password: 'Senha@123', captchaToken: 'TOKEN-123' });
    expect(replace).toHaveBeenCalledWith('/dashboard');
  });

  it('login recusado: mostra o erro e pede um novo desafio (token é de uso único)', async () => {
    get.mockResolvedValue({ captcha: { provider: 'turnstile', siteKey: '0x4AAA-site', action: 'login' } });
    post.mockRejectedValue(new FakeApiError(401, 'E-mail ou senha inválidos.'));
    const w = await mountLogin();
    await w.find('[data-testid="solve"]').trigger('click');
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(w.text()).toContain('E-mail ou senha inválidos.');
    expect(reset).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('desligado no servidor: sem widget, login como antes (sem captchaToken)', async () => {
    get.mockResolvedValue({ captcha: null });
    post.mockResolvedValue({ ok: true });
    const w = await mountLogin();
    expect(w.find('[data-testid="solve"]').exists()).toBe(false);
    await w.find('form').trigger('submit');
    await flushPromises();
    expect(post).toHaveBeenCalledWith('/auth/login', { email: 'erik@ffveiculos.example.com', password: 'Senha@123' });
  });
});
