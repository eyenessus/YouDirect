import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue({ captcha: null }), post: vi.fn() },
  ApiRequestError: class extends Error {},
}));
vi.mock('vue-router', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useRoute: () => ({ query: {}, params: { token: 'abc' } }),
  RouterLink: defineComponent({ props: { to: [String, Object] }, setup: (p, { slots }) => () => h('a', { href: String(p.to) }, slots.default?.()) }),
}));

import { authPhotos } from '@/features/auth/auth-photos';
import AuthShell from '@/features/auth/AuthShell.vue';
import AuthCollage from '@/features/auth/AuthCollage.vue';
import PhotoCreditsPage from '@/features/auth/PhotoCreditsPage.vue';
import ForgotPasswordPage from '@/features/auth/ForgotPasswordPage.vue';
import ResetPasswordPage from '@/features/auth/ResetPasswordPage.vue';
import AcceptInvitePage from '@/features/auth/AcceptInvitePage.vue';
import LoginPage from '@/features/auth/LoginPage.vue';

const publicDir = resolve(__dirname, '../../public');

beforeEach(() => setActivePinia(createPinia()));

describe('fotos de fundo das telas de acesso', () => {
  it('cada foto existe, é leve e tem autor, licença permitida e origem no Wikimedia Commons', () => {
    expect(authPhotos.length).toBeGreaterThanOrEqual(6);
    const ids = new Set<number>();
    for (const p of authPhotos) {
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
      const file = resolve(publicDir, p.src.replace(/^\//, ''));
      expect(existsSync(file), p.src).toBe(true);
      expect(statSync(file).size, p.src).toBeLessThan(600 * 1024);
      expect(p.author.trim().length).toBeGreaterThan(1);
      // Só licenças que permitem uso comercial; CC BY exige o crédito mostrado na página.
      expect(['CC0', 'CC BY 2.0', 'CC BY 4.0']).toContain(p.license);
      expect(p.licenseUrl).toMatch(/^https:\/\/creativecommons\.org\//);
      expect(p.source).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
    }
  });

  it('a página de créditos lista todas as fotos com autor, licença e link de origem', () => {
    const w = mount(PhotoCreditsPage);
    const items = w.findAll('li');
    expect(items).toHaveLength(authPhotos.length);
    for (const p of authPhotos) {
      expect(w.text()).toContain(p.author);
      expect(w.find(`a[href="${p.source}"]`).exists()).toBe(true);
      expect(w.find(`a[href="${p.licenseUrl}"]`).exists()).toBe(true);
    }
    expect(w.text()).toContain('não tem relação com a Ferrari');
  });

  it('o mosaico repete as fotos 3x por coluna (loop sem salto) e é decorativo', () => {
    const w = mount(AuthCollage);
    expect(w.attributes('aria-hidden')).toBe('true');
    const imgs = w.findAll('img');
    expect(imgs).toHaveLength(authPhotos.length * 3);
    expect(imgs.every((i) => i.attributes('alt') === '' && i.attributes('loading') === 'lazy')).toBe(true);
    const compact = mount(AuthCollage, { props: { compact: true } });
    expect(compact.findAll('img')).toHaveLength(5 * 3); // faixa do celular baixa menos fotos
  });

  it('a moldura mostra o conteúdo, a marca e o link de créditos', () => {
    const w = mount(AuthShell, { slots: { default: '<p data-testid="conteudo">olá</p>' } });
    expect(w.find('[data-testid="conteudo"]').exists()).toBe(true);
    expect(w.text()).toContain('Gestão completa da sua');
    expect(w.findAll('a[href="/creditos-fotos"]').length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['entrar', LoginPage, 'Entrar'],
    ['esqueci a senha', ForgotPasswordPage, 'Esqueci a senha'],
    ['nova senha', ResetPasswordPage, 'Nova senha'],
    ['convite', AcceptInvitePage, null],
  ])('a tela "%s" usa o painel com as fotos', async (_name, Page, heading) => {
    const w = mount(Page);
    await flushPromises();
    expect(w.findComponent(AuthShell).exists()).toBe(true);
    expect(w.findComponent(AuthCollage).exists()).toBe(true);
    if (heading) expect(w.text()).toContain(heading);
  });
});
