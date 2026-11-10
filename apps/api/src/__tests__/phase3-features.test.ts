import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { fullMatrix, type PermissionMatrix } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';
import { hashPassword } from '../common/helpers.js';
import { weekKey } from '../services/notifications.js';

/* ------------------------------------------------------------------ *
 * Fase 3 — funcionalidades: convites/papéis, vistoria reagendada,
 * exportações, auditoria/LGPD, leitura por usuário, assinatura padrão.
 * ------------------------------------------------------------------ */

describe('funcionalidades da fase 3', () => {
  let harness: TestHarness;
  let owner: string;
  let organizationId: ObjectId;

  const call = (cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    harness.app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload ? { payload: payload as object } : {}) });

  const login = async (email: string, password: string) => {
    const res = await harness.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
    expect(res.statusCode, res.body).toBe(200);
    return sessionCookie(res.headers as Record<string, unknown>);
  };

  async function member(email: string, role: 'ADMIN' | 'MEMBER', permissions: PermissionMatrix, org = organizationId) {
    const now = new Date();
    const userId = new ObjectId();
    await harness.ctx.mongo.collections.users.insertOne({
      _id: userId,
      name: email,
      emailLower: email,
      passwordHash: await hashPassword('Senha-forte-123'),
      phone: null,
      status: 'ACTIVE',
      browserNotificationsEnabled: false,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const membershipId = new ObjectId();
    await harness.ctx.mongo.collections.memberships.insertOne({
      _id: membershipId,
      organizationId: org,
      userId,
      role,
      permissions,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });
    return { userId, membershipId, cookie: await login(email, 'Senha-forte-123') };
  }

  beforeAll(async () => {
    harness = await createHarness();
    await seed(harness.ctx);
    owner = await login(harness.env.SEED_OWNER_EMAIL, harness.env.SEED_OWNER_PASSWORD);
    const me = (await call(owner, 'GET', '/auth/me')).json();
    organizationId = new ObjectId(me.organization.id as string);
  }, 180_000);

  afterAll(async () => harness?.close());

  it('F2: reenviar convite gera link novo e invalida o anterior', async () => {
    const created = await call(owner, 'POST', '/invitations', {
      name: 'Convidado',
      email: 'convidado.f2@exemplo.com.br',
      permissions: { dashboard: ['read'] },
    });
    expect(created.statusCode, created.body).toBe(201);
    const first = created.json().acceptUrl as string;
    const resent = await call(owner, 'POST', `/invitations/${created.json().id}/resend`);
    expect(resent.statusCode, resent.body).toBe(200);
    const second = resent.json().acceptUrl as string;
    expect(second).not.toBe(first);
    const oldToken = first.split('/').at(-1)!;
    const newToken = second.split('/').at(-1)!;
    expect((await harness.app.inject({ method: 'GET', url: `/api/v1/invitations/${oldToken}` })).statusCode).toBe(404);
    expect((await harness.app.inject({ method: 'GET', url: `/api/v1/invitations/${newToken}` })).statusCode).toBe(200);
  });

  it('F2: só o proprietário promove; ADMIN não mexe em outro ADMIN', async () => {
    const a = await member('admin.a@exemplo.com.br', 'ADMIN', fullMatrix());
    const b = await member('membro.b@exemplo.com.br', 'MEMBER', { dashboard: ['read'] });
    expect((await call(a.cookie, 'PATCH', `/memberships/${b.membershipId}/role`, { role: 'ADMIN' })).statusCode).toBe(403);
    expect((await call(owner, 'PATCH', `/memberships/${b.membershipId}/role`, { role: 'ADMIN' })).statusCode).toBe(200);
    expect(
      (await call(a.cookie, 'PATCH', `/memberships/${b.membershipId}/permissions`, { permissions: {} })).statusCode,
    ).toBe(403);
    expect((await call(a.cookie, 'DELETE', `/memberships/${b.membershipId}`)).statusCode).toBe(403);
  });

  it('F6: reagenda vistoria pendente (prazo = data + 2 dias)', async () => {
    const inspection = await harness.ctx.mongo.collections.inspections.findOne({ organizationId, status: 'PENDING' });
    expect(inspection).toBeTruthy();
    const res = await call(owner, 'PATCH', `/inspections/${inspection!._id.toHexString()}/schedule`, {
      scheduledAt: '2030-01-10',
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await harness.ctx.mongo.collections.inspections.findOne({ _id: inspection!._id });
    expect(after!.scheduledAt).toBe('2030-01-10');
    expect(after!.dueDate).toBe('2030-01-12');

    const approved = await harness.ctx.mongo.collections.inspections.findOne({ organizationId, status: { $ne: 'PENDING' } });
    if (approved) {
      expect(
        (await call(owner, 'PATCH', `/inspections/${approved._id.toHexString()}/schedule`, { scheduledAt: '2030-01-10' }))
          .statusCode,
      ).toBe(409);
    }
  });

  it('F8: CSV de veículos com BOM e ";", e exige a permissão export', async () => {
    const res = await call(owner, 'GET', '/exports/vehicles.csv');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.charCodeAt(0)).toBe(0xfeff);
    expect(res.body.split('\r\n')[0]).toContain('"Placa";"Marca"');
    for (const path of ['/exports/drivers.csv', '/exports/payables.csv', '/exports/receivables.csv']) {
      expect((await call(owner, 'GET', path)).statusCode).toBe(200);
    }
    const reader = await member('leitor.f8@exemplo.com.br', 'MEMBER', { vehicles: ['read'] });
    expect((await call(reader.cookie, 'GET', '/exports/vehicles.csv')).statusCode).toBe(403);
    const log = await harness.ctx.mongo.collections.auditLogs.findOne({ organizationId, action: 'export.csv', entityType: 'vehicle' });
    expect(log).toBeTruthy();
  });

  it('F9: auditoria lista sem segredos e só para OWNER/ADMIN', async () => {
    const res = await call(owner, 'GET', '/audit-logs?limit=100');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBeGreaterThan(0);
    expect(res.body).not.toMatch(/passwordHash|tokenHash|cpfEncrypted/);
    const plain = await member('plain.f9@exemplo.com.br', 'MEMBER', { dashboard: ['read'] });
    expect((await call(plain.cookie, 'GET', '/audit-logs')).statusCode).toBe(403);
  });

  it('F9: exportação LGPD traz o CPF; anonimização apaga dados e preserva o financeiro', async () => {
    // Todos os motoristas do seed têm locação ativa: encerra a de um deles.
    const active = await harness.ctx.mongo.collections.rentals.find({ organizationId, status: 'ACTIVE' }).toArray();
    const rental = active.find((r) => active.filter((o) => o.driverId.equals(r.driverId)).length === 1)!;
    const closed = await call(owner, 'POST', `/rentals/${rental._id.toHexString()}/close`, { endDate: rental.startDate });
    expect(closed.statusCode, closed.body).toBe(200);
    const rentedDriverIds = await harness.ctx.mongo.collections.rentals.distinct('driverId', { organizationId, status: 'ACTIVE' });
    const driver = await harness.ctx.mongo.collections.drivers.findOne({ _id: rental.driverId });
    expect(driver).toBeTruthy();
    const receivablesBefore = await harness.ctx.mongo.collections.receivables.countDocuments({ driverId: rental.driverId });
    const id = driver!._id.toHexString();

    const exported = await call(owner, 'GET', `/drivers/${id}/data-export`);
    expect(exported.statusCode).toBe(200);
    const data = JSON.parse(exported.body);
    expect(data.driver.fullName).toBe(driver!.fullName);
    expect(data.driver.cpfEncrypted).toBeUndefined();

    expect((await call(owner, 'POST', `/drivers/${id}/anonymize`, { confirm: 'sim' })).statusCode).toBe(400);
    const ok = await call(owner, 'POST', `/drivers/${id}/anonymize`, { confirm: 'ANONIMIZAR' });
    expect(ok.statusCode, ok.body).toBe(200);
    const after = await harness.ctx.mongo.collections.drivers.findOne({ _id: driver!._id });
    expect(after!.fullName).toMatch(/^Motorista anonimizado/);
    expect(after!.cpfEncrypted).toBeNull();
    expect(after!.phone).toBe('');
    expect(after!.archivedAt).toBeInstanceOf(Date);
    expect(await harness.ctx.mongo.collections.receivables.countDocuments({ driverId: rental.driverId })).toBe(
      receivablesBefore,
    );

    const withRental = rentedDriverIds[0] as ObjectId | undefined;
    if (withRental) {
      expect(
        (await call(owner, 'POST', `/drivers/${withRental.toHexString()}/anonymize`, { confirm: 'ANONIMIZAR' })).statusCode,
      ).toBe(409);
    }
  });

  it('F10: marcar como lida vale só para quem leu', async () => {
    await call(owner, 'POST', '/notifications/refresh');
    const colleague = await member('colega.f10@exemplo.com.br', 'MEMBER', { notifications: ['read'] });
    const before = (await call(colleague.cookie, 'GET', '/notifications/unread-count')).json().unread as number;
    expect(before).toBeGreaterThan(0);
    const all = await call(owner, 'POST', '/notifications/mark-all-read');
    expect(all.statusCode).toBe(200);
    expect((await call(owner, 'GET', '/notifications/unread-count')).json().unread).toBe(0);
    expect((await call(colleague.cookie, 'GET', '/notifications/unread-count')).json().unread).toBe(before);
    // Ler exige só "ver notificações".
    const list = (await call(colleague.cookie, 'GET', '/notifications')).json().data as Array<{ id: string }>;
    expect((await call(colleague.cookie, 'PATCH', `/notifications/${list[0]!.id}/read`)).statusCode).toBe(200);
    expect((await call(colleague.cookie, 'GET', '/notifications/unread-count')).json().unread).toBe(before - 1);
  });

  it('F10: lembrete de atraso é semanal (segunda-feira da semana)', () => {
    expect(weekKey('2026-11-10')).toBe('2026-11-09');
    expect(weekKey('2026-11-09')).toBe('2026-11-09');
    expect(weekKey('2026-11-15')).toBe('2026-11-09');
    expect(weekKey('2026-11-16')).toBe('2026-11-16');
  });

  it('F11: organização sem assinatura recebe uma de teste', async () => {
    await harness.ctx.mongo.collections.subscriptions.deleteMany({ organizationId });
    const res = await call(owner, 'GET', '/subscription');
    expect(res.statusCode, res.body).toBe(200);
    expect(await harness.ctx.mongo.collections.subscriptions.countDocuments({ organizationId })).toBe(1);
    const sub = await harness.ctx.mongo.collections.subscriptions.findOne({ organizationId });
    expect(sub!.status).toBe('TRIAL');
  });
});
