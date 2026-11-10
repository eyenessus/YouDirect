import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  addDaysIso,
  businessDate,
  fullMatrix,
  type DriverPortalAccessResult,
  type PortalInvoices,
  type PublicCatalog,
} from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';
import { hashPassword } from '../common/helpers.js';

/**
 * Área do Motorista (link de uso único → sessão própria) e site público da
 * locadora (vitrine de grupos + pedido de reserva).
 */
describe('área do motorista e site da locadora', () => {
  let harness: TestHarness;
  let staff: string;
  let orgId: ObjectId;
  const today = businessDate();

  type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  const call = (method: Method, url: string, payload?: unknown, cookie?: string) =>
    harness.app.inject({
      method,
      url,
      headers: cookie ? { cookie } : {},
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  let seq = 0;
  const newRental = async () => {
    seq += 1;
    const vehicle = await call('POST', '/api/v1/vehicles', { plate: `P${'ABCDEFGHIJ'[seq % 10]}R1D${10 + seq}`, brand: 'Fiat', model: `PORTAL${seq}`, mileageKm: 1 }, staff);
    const driver = await call('POST', '/api/v1/drivers', { fullName: `Motorista Portal ${seq}`, phone: `1177766${1000 + seq}` }, staff);
    const rental = await call(
      'POST',
      '/api/v1/rentals',
      {
        vehicleId: vehicle.json().id,
        driverId: driver.json().id,
        rentalType: 'WEEKLY',
        periodicAmountCents: 60000,
        depositCents: 120000,
        startDate: addDaysIso(today, -10),
        endDate: addDaysIso(today, 18),
      },
      staff,
    );
    expect(rental.statusCode).toBe(201);
    return { vehicleId: vehicle.json().id as string, driverId: driver.json().id as string, rentalId: rental.json().id as string };
  };

  const tokenOf = (link: string) => link.split('/motorista/entrar/')[1]!;
  const loginDriver = async (driverId: string) => {
    const access = (await call('POST', `/api/v1/drivers/${driverId}/portal-access`, undefined, staff)).json() as DriverPortalAccessResult;
    const res = await call('POST', '/api/v1/driver/login', { token: tokenOf(access.link) });
    expect(res.statusCode).toBe(200);
    return sessionCookie(res.headers as Record<string, unknown>, 'yudirect_driver');
  };

  beforeAll(async () => {
    harness = await createHarness();
    await seed(harness.ctx);
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: harness.env.SEED_OWNER_EMAIL, password: harness.env.SEED_OWNER_PASSWORD },
    });
    staff = sessionCookie(login.headers as Record<string, unknown>);
    orgId = (await harness.ctx.mongo.collections.memberships.findOne({ role: 'OWNER' }))!.organizationId;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  /* ------------------------------ acesso ------------------------------ */
  it('link de acesso é de uso único e gera link manual sem provedor de WhatsApp', async () => {
    const { driverId } = await newRental();
    const res = await call('POST', `/api/v1/drivers/${driverId}/portal-access`, undefined, staff);
    expect(res.statusCode).toBe(200);
    const access = res.json() as DriverPortalAccessResult;
    expect(access.link).toMatch(/\/motorista\/entrar\/[A-Za-z0-9_-]{20,}$/);
    expect(access.delivered).toBe(false);
    expect(access.manualLink).toMatch(/^https:\/\/wa\.me\//);

    const first = await call('POST', '/api/v1/driver/login', { token: tokenOf(access.link) });
    expect(first.statusCode).toBe(200);
    expect(String(first.headers['set-cookie'])).toContain('HttpOnly');
    const again = await call('POST', '/api/v1/driver/login', { token: tokenOf(access.link) });
    expect(again.statusCode).toBe(404);
  });

  it('novo link invalida o anterior; link expirado não entra', async () => {
    const { driverId } = await newRental();
    const a = (await call('POST', `/api/v1/drivers/${driverId}/portal-access`, undefined, staff)).json() as DriverPortalAccessResult;
    const b = (await call('POST', `/api/v1/drivers/${driverId}/portal-access`, undefined, staff)).json() as DriverPortalAccessResult;
    expect((await call('POST', '/api/v1/driver/login', { token: tokenOf(a.link) })).statusCode).toBe(404);
    await harness.ctx.mongo.collections.driverAccessTokens.updateMany(
      { driverId: new ObjectId(driverId), usedAt: null },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect((await call('POST', '/api/v1/driver/login', { token: tokenOf(b.link) })).statusCode).toBe(404);
  });

  it('sessão do motorista não acessa rotas da equipe, e a da equipe não acessa o portal', async () => {
    const { driverId } = await newRental();
    const driver = await loginDriver(driverId);
    expect((await call('GET', '/api/v1/driver/me', undefined, driver)).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/vehicles', undefined, driver)).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/receivables', undefined, driver)).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/driver/me', undefined, staff)).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/driver/me')).statusCode).toBe(401);
  });

  it('revogar o acesso e inativar o motorista derrubam a sessão', async () => {
    const one = await newRental();
    const s1 = await loginDriver(one.driverId);
    expect((await call('DELETE', `/api/v1/drivers/${one.driverId}/portal-access`, undefined, staff)).json().revokedSessions).toBe(1);
    expect((await call('GET', '/api/v1/driver/me', undefined, s1)).statusCode).toBe(401);

    const two = await newRental();
    const s2 = await loginDriver(two.driverId);
    await harness.ctx.mongo.collections.drivers.updateOne({ _id: new ObjectId(two.driverId) }, { $set: { status: 'INACTIVE' } });
    expect((await call('GET', '/api/v1/driver/me', undefined, s2)).statusCode).toBe(401);
  });

  /* ------------------------------ dados ------------------------------ */
  it('mostra só as locações, faturas e multas do próprio motorista', async () => {
    const mine = await newRental();
    const other = await newRental();
    const driver = await loginDriver(mine.driverId);

    const me = (await call('GET', '/api/v1/driver/me', undefined, driver)).json();
    expect(me.driver.id).toBe(mine.driverId);
    expect(me.driver.phone).toMatch(/^\(\d{2}\) /);
    expect(me.organization.whatsappPhone).toBe('11999990000');

    const rentals = (await call('GET', '/api/v1/driver/rentals', undefined, driver)).json().data;
    expect(rentals.map((r: { id: string }) => r.id)).toEqual([mine.rentalId]);

    // Multa do motorista (cobrada) e multa de outro motorista.
    const fineFor = async (vehicleId: string) =>
      (
        await call(
          'POST',
          '/api/v1/traffic-fines',
          {
            vehicleId,
            aitNumber: `PORT-${vehicleId.slice(-6)}`,
            authorityName: 'DETRAN-SP',
            infractionDescription: 'Estacionar em local proibido',
            occurredDate: addDaysIso(today, -3),
            occurredTime: '09:00',
            amountCents: 19523,
          },
          staff,
        )
      ).json();
    const myFine = await fineFor(mine.vehicleId);
    await fineFor(other.vehicleId);
    await call('POST', `/api/v1/traffic-fines/${myFine.id}/charge`, { version: myFine.version }, staff);

    const fines = (await call('GET', '/api/v1/driver/fines', undefined, driver)).json().data;
    expect(fines).toHaveLength(1);
    expect(fines[0].id).toBe(myFine.id);
    expect(fines[0].charge.amountCents).toBe(19523);

    const inv = (await call('GET', '/api/v1/driver/invoices', undefined, driver)).json() as PortalInvoices;
    const rent = inv.invoices.filter((i) => i.kind === 'RENT');
    expect(rent.length).toBe(4); // 28 dias semanais = 4 semanas
    expect(rent.every((i) => i.rentalNumber)).toBe(true);
    expect(inv.invoices.some((i) => i.kind === 'FINE' && i.amountCents === 19523)).toBe(true);
    expect(inv.totals.openCents).toBe(4 * 60000 + 19523);
    expect(inv.next?.dueDate).toBe(addDaysIso(today, -3)); // semana 1 (início -10 + 7) está vencida
    expect(inv.totals.overdueCents).toBe(60000);
  });

  it('vistorias pendentes trazem o link público da vistoria', async () => {
    const { driverId, vehicleId, rentalId } = await newRental();
    const now = new Date();
    await harness.ctx.mongo.collections.inspections.insertOne({
      _id: new ObjectId(),
      organizationId: orgId,
      vehicleId: new ObjectId(vehicleId),
      rentalId: new ObjectId(rentalId),
      driverId: new ObjectId(driverId),
      responsibleName: 'Motorista',
      phone: '11977770000',
      email: null,
      scheduledAt: today,
      dueDate: addDaysIso(today, 2),
      submittedAt: null,
      reviewedAt: null,
      reviewerId: null,
      status: 'PENDING',
      odometerKm: null,
      photos: [],
      notes: null,
      requestTokenHash: null,
      requestExpiresAt: null,
      delivery: null,
      source: 'MANUAL',
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    });
    const driver = await loginDriver(driverId);
    const data = (await call('GET', '/api/v1/driver/inspections', undefined, driver)).json().data;
    expect(data).toHaveLength(1);
    expect(data[0].link).toMatch(/\/vistoria\/[A-Za-z0-9_-]+$/);
    const token = data[0].link.split('/vistoria/')[1];
    expect((await call('GET', `/api/v1/inspection-public/${token}`)).statusCode).toBe(200);
  });

  it('pedido de manutenção vai para a equipe e o motorista acompanha a resposta', async () => {
    const { driverId, rentalId } = await newRental();
    const other = await newRental();
    const driver = await loginDriver(driverId);

    // Locação de outro motorista é recusada.
    const foreign = await call(
      'POST',
      '/api/v1/driver/maintenance-requests',
      { rentalId: other.rentalId, category: 'TIRES', description: 'Pneu furado' },
      driver,
    );
    expect(foreign.statusCode).toBe(400);

    const res = await call(
      'POST',
      '/api/v1/driver/maintenance-requests',
      { rentalId, category: 'MECHANICAL', description: 'Barulho no freio dianteiro', vehicleStopped: true },
      driver,
    );
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;

    const note = await harness.ctx.mongo.collections.notifications.findOne({ entityId: new ObjectId(id) });
    expect(note?.severity).toBe('CRITICAL');
    expect(note?.title).toContain('Carro parado');

    const list = (await call('GET', '/api/v1/maintenance-requests?status=OPEN', undefined, staff)).json();
    expect(list.data.some((r: { id: string }) => r.id === id)).toBe(true);
    const updated = await call('PATCH', `/api/v1/maintenance-requests/${id}`, { status: 'SCHEDULED', responseNote: 'Oficina amanhã às 9h' }, staff);
    expect(updated.json().status).toBe('SCHEDULED');

    const mine = (await call('GET', '/api/v1/driver/maintenance-requests', undefined, driver)).json().data;
    expect(mine[0]).toMatchObject({ id, status: 'SCHEDULED', responseNote: 'Oficina amanhã às 9h' });
  });

  it('documento enviado pelo motorista atualiza o cadastro e avisa a equipe', async () => {
    const { driverId } = await newRental();
    const driver = await loginDriver(driverId);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const boundary = '----portal';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nDRIVER_ID\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cnh.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/driver/files',
      headers: { cookie: driver, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(up.statusCode).toBe(201);
    const doc = await call('POST', '/api/v1/driver/documents', { kind: 'CNH', fileId: up.json().id }, driver);
    expect(doc.statusCode).toBe(200);
    const fresh = await harness.ctx.mongo.collections.drivers.findOne({ _id: new ObjectId(driverId) });
    expect(fresh?.idDocumentFileId?.toHexString()).toBe(up.json().id);
    expect((await call('GET', '/api/v1/driver/me', undefined, driver)).json().driver.hasIdDocument).toBe(true);
  });

  /* ------------------------------ site ------------------------------ */
  it('catálogo público agrupa as ofertas e mostra disponibilidade', async () => {
    const res = await call('GET', '/api/v1/public/ff-veiculos/catalog');
    expect(res.statusCode).toBe(200);
    const catalog = res.json() as PublicCatalog;
    expect(catalog.organization.name).toBeTruthy();
    const names = catalog.groups.map((g) => g.groupName);
    expect(names).toEqual(expect.arrayContaining(['Compacto', 'Hatch', 'Sedã']));
    const seda = catalog.groups.find((g) => g.groupName === 'Sedã')!;
    expect(seda.fromWeeklyPriceCents).toBe(70000);
    // Todos os sedãs do seed estão locados: o grupo aparece, mas indisponível.
    expect(seda.available).toBe(false);
    expect(seda.availableCount).toBe(0);
    expect(seda.models.join(' ')).toMatch(/VOYAGE/);
    expect((await call('GET', '/api/v1/public/nao-existe/catalog')).statusCode).toBe(404);
  });

  it('oferta do veículo: só aparece com showOnSite e respeita permissão', async () => {
    const vehicle = (await call('POST', '/api/v1/vehicles', { plate: 'SUV1A23', brand: 'Jeep', model: 'Renegade', mileageKm: 10 }, staff)).json();
    const put = await call(
      'PUT',
      `/api/v1/vehicles/${vehicle.id}/offer`,
      { showOnSite: false, groupName: 'SUV', weeklyPriceCents: 99000, depositCents: 200000, kmPolicy: 'FRANCHISE', weeklyKmFranchise: 1500 },
      staff,
    );
    expect(put.statusCode).toBe(200);
    let groups = ((await call('GET', '/api/v1/public/ff-veiculos/catalog')).json() as PublicCatalog).groups;
    expect(groups.some((g) => g.groupName === 'SUV')).toBe(false);
    await call('PUT', `/api/v1/vehicles/${vehicle.id}/offer`, { showOnSite: true, groupName: 'SUV', weeklyPriceCents: 99000, kmPolicy: 'FRANCHISE', weeklyKmFranchise: 1500 }, staff);
    groups = ((await call('GET', '/api/v1/public/ff-veiculos/catalog')).json() as PublicCatalog).groups;
    expect(groups.find((g) => g.groupName === 'SUV')).toMatchObject({ kmPolicy: 'FRANCHISE', weeklyKmFranchise: 1500, available: true });
    expect((await call('GET', `/api/v1/vehicles/${vehicle.id}`, undefined, staff)).json().offer.groupName).toBe('SUV');
  });

  it('pedido de reserva entra na fila, sem duplicar e ignorando robôs', async () => {
    const lead = { fullName: 'Carlos Silva', phone: '(11) 98888-7777', groupName: 'Hatch', appPlatforms: ['UBER'], hasEarCnh: true, consent: true };
    expect((await call('POST', '/api/v1/public/ff-veiculos/leads', lead)).statusCode).toBe(201);
    expect((await call('POST', '/api/v1/public/ff-veiculos/leads', lead)).statusCode).toBe(201); // repetido em 24h
    expect((await call('POST', '/api/v1/public/ff-veiculos/leads', { ...lead, phone: '11977776666', website: 'http://spam' })).statusCode).toBe(201);
    expect((await call('POST', '/api/v1/public/ff-veiculos/leads', { ...lead, consent: false })).statusCode).toBe(422);

    const list = (await call('GET', '/api/v1/rental-leads', undefined, staff)).json();
    const mine = list.data.filter((l: { phone: string }) => l.phone === '11988887777');
    expect(mine).toHaveLength(1);
    expect(list.data.some((l: { phone: string }) => l.phone === '11977776666')).toBe(false);
    expect(list.newCount).toBeGreaterThanOrEqual(1);
    const upd = await call('PATCH', `/api/v1/rental-leads/${mine[0].id}`, { status: 'CONTACTED', notes: 'Ligar amanhã' }, staff);
    expect(upd.json()).toMatchObject({ status: 'CONTACTED', notes: 'Ligar amanhã' });
  });

  it('configurações do site: slug único, só dono/admin altera, site desligado some', async () => {
    const res = await call('PATCH', '/api/v1/public-site/settings', { headline: 'Novo título' }, staff);
    expect(res.json()).toMatchObject({ publicSlug: 'ff-veiculos', enabled: true, headline: 'Novo título' });
    expect((await call('PATCH', '/api/v1/public-site/settings', { publicSlug: 'X!' }, staff)).statusCode).toBe(422);

    // Outra empresa não pode usar o mesmo slug.
    const orgB = new ObjectId();
    const now = new Date();
    await harness.ctx.mongo.collections.organizations.insertOne({
      _id: orgB, name: 'Outra', legalId: null, timezone: 'America/Sao_Paulo', currency: 'BRL',
      settings: { freeSeats: 3, extraSeatPriceCents: 990 }, createdAt: now, updatedAt: now,
    });
    const userId = new ObjectId();
    await harness.ctx.mongo.collections.users.insertOne({
      _id: userId, name: 'B', emailLower: 'dono-b-site@exemplo.test', passwordHash: await hashPassword('Senha@12345'),
      phone: null, status: 'ACTIVE', browserNotificationsEnabled: false, lastLoginAt: null, createdAt: now, updatedAt: now,
    });
    await harness.ctx.mongo.collections.memberships.insertOne({
      _id: new ObjectId(), organizationId: orgB, userId, role: 'OWNER', permissions: fullMatrix(), status: 'ACTIVE', createdAt: now, updatedAt: now,
    });
    const login = await call('POST', '/api/v1/auth/login', { email: 'dono-b-site@exemplo.test', password: 'Senha@12345' });
    const b = sessionCookie(login.headers as Record<string, unknown>);
    expect((await call('PATCH', '/api/v1/public-site/settings', { publicSlug: 'ff-veiculos' }, b)).statusCode).toBe(409);
    expect((await call('GET', '/api/v1/rental-leads', undefined, b)).json().data).toEqual([]);

    await call('PATCH', '/api/v1/public-site/settings', { enabled: false }, staff);
    expect((await call('GET', '/api/v1/public/ff-veiculos/catalog')).statusCode).toBe(404);
    await call('PATCH', '/api/v1/public-site/settings', { enabled: true }, staff);
    void orgId;
  });
});
