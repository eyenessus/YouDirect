import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { addDaysIso, businessDate, fullMatrix, type RentalPaymentsView, type TrafficFine } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';
import { hashPassword } from '../common/helpers.js';
import { generateFineNotifications } from '../services/notifications.js';

/**
 * Multas: cadastro com identificação automática do motorista, indicação,
 * cobrança como conta a receber (kind FINE), pagamento, estorno, recurso,
 * cancelamento, permissões, isolamento entre empresas e avisos de prazo.
 */
describe('multas de trânsito', () => {
  let harness: TestHarness;
  let cookie: string;
  let orgId: ObjectId;
  const today = businessDate();

  type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
  const call = (method: Method, url: string, payload?: unknown, c = cookie) =>
    harness.app.inject({
      method,
      url,
      headers: { cookie: c },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  let seq = 0;
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const newVehicle = async () => {
    seq += 1;
    const vehicle = await call('POST', '/api/v1/vehicles', {
      plate: `M${letters[seq % 26]}${letters[Math.floor(seq / 26) % 26]}7F21`,
      brand: 'Fiat',
      model: `MUL${seq}`,
      mileageKm: 1,
    });
    expect(vehicle.statusCode).toBe(201);
    return vehicle.json().id as string;
  };
  const newRental = async (vehicleId?: string) => {
    const vId = vehicleId ?? (await newVehicle());
    const driver = await call('POST', '/api/v1/drivers', { fullName: `Motorista Multa ${seq}`, phone: `1188800${1000 + seq}` });
    const rental = await call('POST', '/api/v1/rentals', {
      vehicleId: vId,
      driverId: driver.json().id,
      rentalType: 'WEEKLY',
      periodicAmountCents: 70000,
      depositCents: 0,
      startDate: addDaysIso(today, -10),
      endDate: addDaysIso(today, 18),
    });
    expect(rental.statusCode).toBe(201);
    return { vehicleId: vId, driverId: driver.json().id as string, rentalId: rental.json().id as string };
  };

  let ait = 1000;
  const createFine = (vehicleId: string, extra: Record<string, unknown> = {}, c = cookie) => {
    ait += 1;
    return call(
      'POST',
      '/api/v1/traffic-fines',
      {
        vehicleId,
        aitNumber: `SP-${ait}`,
        authorityName: 'DETRAN-SP',
        infractionCode: '7455-0',
        infractionDescription: 'Transitar em velocidade superior à máxima permitida em até 20%',
        gravity: 'MEDIUM',
        occurredDate: addDaysIso(today, -2),
        occurredTime: '10:30',
        amountCents: 13016,
        discountedAmountCents: 10413,
        discountUntil: addDaysIso(today, 20),
        indicationDeadline: addDaysIso(today, 15),
        ...extra,
      },
      c,
    );
  };
  const getFine = async (id: string) => (await call('GET', `/api/v1/traffic-fines/${id}`)).json() as TrafficFine;

  const defaultAccountId = async () => {
    const acc = (await call('GET', '/api/v1/bank-accounts')).json();
    return ((acc.data ?? acc) as Array<{ id: string; isDefault: boolean }>).find((a) => a.isDefault)!.id;
  };

  const loginAs = async (email: string, organizationId: ObjectId, role: 'OWNER' | 'MEMBER', permissions: Record<string, string[]>) => {
    const now = new Date();
    const userId = new ObjectId();
    await harness.ctx.mongo.collections.users.insertOne({
      _id: userId,
      name: email,
      emailLower: email,
      passwordHash: await hashPassword('Senha@12345'),
      phone: null,
      status: 'ACTIVE',
      browserNotificationsEnabled: false,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await harness.ctx.mongo.collections.memberships.insertOne({
      _id: new ObjectId(),
      organizationId,
      userId,
      role,
      permissions: permissions as never,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'Senha@12345' },
    });
    return sessionCookie(login.headers as Record<string, unknown>);
  };

  beforeAll(async () => {
    harness = await createHarness();
    await seed(harness.ctx);
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: harness.env.SEED_OWNER_EMAIL, password: harness.env.SEED_OWNER_PASSWORD },
    });
    cookie = sessionCookie(login.headers as Record<string, unknown>);
    orgId = (await harness.ctx.mongo.collections.memberships.findOne({ role: 'OWNER' }))!.organizationId;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  /* ------------------------------ cadastro ------------------------------ */
  it('identifica o motorista automaticamente pela locação da data', async () => {
    const { vehicleId, driverId, rentalId } = await newRental();
    const res = await createFine(vehicleId);
    expect(res.statusCode).toBe(201);
    const fine = res.json() as TrafficFine;
    expect(fine.fineNumber).toMatch(/^MUL-\d{4}-\d{3,}$/);
    expect(fine.status).toBe('DRIVER_IDENTIFIED');
    expect(fine.match.confidence).toBe('HIGH');
    expect(fine.match.driver?.id).toBe(driverId);
    expect(fine.match.rental?.id).toBe(rentalId);
    expect(fine.occurredOn).toBe(addDaysIso(today, -2));
    expect(fine.chargeAmountCents).toBe(10413); // ainda no prazo do desconto
    expect(fine.history.map((h) => h.action)).toEqual(['created', 'matched']);
  });

  it('veículo sem locação na data fica para identificação manual', async () => {
    const vehicleId = await newVehicle();
    const fine = (await createFine(vehicleId)).json() as TrafficFine;
    expect(fine.status).toBe('RECEIVED');
    expect(fine.match.confidence).toBe('NONE');
    expect(fine.match.driver).toBeNull();

    // Cobrar sem motorista é recusado.
    expect((await call('POST', `/api/v1/traffic-fines/${fine.id}/charge`, { version: fine.version })).statusCode).toBe(409);

    const driver = (await call('POST', '/api/v1/drivers', { fullName: 'Condutor Manual', phone: '11977776666' })).json();
    const identified = await call('POST', `/api/v1/traffic-fines/${fine.id}/identify`, { driverId: driver.id, version: fine.version });
    expect(identified.statusCode).toBe(200);
    expect(identified.json().status).toBe('DRIVER_IDENTIFIED');
    expect(identified.json().match.confidence).toBe('MANUAL');
  });

  it('recusa AIT duplicado, data futura e versão desatualizada', async () => {
    const { vehicleId } = await newRental();
    const first = (await createFine(vehicleId)).json() as TrafficFine;
    const dup = await call('POST', '/api/v1/traffic-fines', {
      vehicleId,
      aitNumber: first.aitNumber.toLowerCase().replace('-', ' '),
      authorityName: 'DETRAN-SP',
      infractionDescription: 'Outra',
      occurredDate: today,
      occurredTime: '00:01',
      amountCents: 100,
    });
    expect(dup.statusCode).toBe(409);
    expect((await createFine(vehicleId, { occurredDate: addDaysIso(today, 2) })).statusCode).toBe(422);
    const stale = await call('PATCH', `/api/v1/traffic-fines/${first.id}`, { notes: 'x', version: first.version + 5 });
    expect(stale.statusCode).toBe(409);
  });

  /* ------------------------------ cobrança ------------------------------ */
  it('cobra do motorista: conta a receber FINE, fora da aba Pagamentos da locação', async () => {
    const { vehicleId, rentalId, driverId } = await newRental();
    const before = (await call('GET', `/api/v1/rentals/${rentalId}/payments`)).json() as RentalPaymentsView;
    const fine = (await createFine(vehicleId)).json() as TrafficFine;

    const charged = await call('POST', `/api/v1/traffic-fines/${fine.id}/charge`, { version: fine.version });
    expect(charged.statusCode).toBe(201);
    const after = charged.json().fine as TrafficFine;
    expect(after.status).toBe('CHARGED');
    expect(after.receivable?.grossAmountCents).toBe(10413);
    // Vencimento padrão: próximo vencimento semanal do aluguel (início -10 → semana 2 = hoje+4).
    expect(after.receivable?.dueDate).toBe(addDaysIso(today, 4));

    const receivable = await harness.ctx.mongo.collections.receivables.findOne({ _id: new ObjectId(after.receivable!.id) });
    expect(receivable?.kind).toBe('FINE');
    expect(receivable?.driverId.toHexString()).toBe(driverId);
    expect(receivable?.trafficFineId?.toHexString()).toBe(fine.id);

    const view = (await call('GET', `/api/v1/rentals/${rentalId}/payments`)).json() as RentalPaymentsView;
    expect(view.summary).toEqual(before.summary);
    expect(view.entries).toEqual(before.entries);

    // Repetir a cobrança não duplica.
    const again = await call('POST', `/api/v1/traffic-fines/${fine.id}/charge`, { version: fine.version });
    expect(again.statusCode).toBe(200);
    expect(again.json().alreadyCharged).toBe(true);
    expect(await harness.ctx.mongo.collections.receivables.countDocuments({ trafficFineId: new ObjectId(fine.id) })).toBe(1);
  });

  it('pagamento quita a multa; estorno volta para cobrada; extrato identifica o reembolso', async () => {
    const { vehicleId } = await newRental();
    const fine = (await createFine(vehicleId)).json() as TrafficFine;
    const charged = (await call('POST', `/api/v1/traffic-fines/${fine.id}/charge`, { version: fine.version, amountCents: 13016 })).json()
      .fine as TrafficFine;
    const accountId = await defaultAccountId();

    const pay = await call('POST', `/api/v1/receivables/${charged.receivable!.id}/payments`, {
      amountCents: 13016,
      paidAt: today,
      method: 'PIX',
      bankAccountId: accountId,
    });
    expect(pay.statusCode).toBe(201);
    expect((await getFine(fine.id)).status).toBe('PAID');

    const tx = await harness.ctx.mongo.collections.bankTransactions.findOne({ originId: new ObjectId(charged.receivable!.id) });
    expect(tx?.description).toMatch(/^Reembolso de multa - /);

    const reversed = await call('POST', `/api/v1/receivables/${charged.receivable!.id}/payments/${pay.json().payment.id}/reverse`, {
      reason: 'PIX devolvido',
    });
    expect(reversed.statusCode).toBe(200);
    const back = await getFine(fine.id);
    expect(back.status).toBe('CHARGED');
    expect(back.history.map((h) => h.action)).toContain('payment_reversed');
  });

  it('cancelar multa paga estorna o pagamento, cancela a conta e libera o AIT', async () => {
    const { vehicleId } = await newRental();
    const fine = (await createFine(vehicleId)).json() as TrafficFine;
    const charged = (await call('POST', `/api/v1/traffic-fines/${fine.id}/charge`, { version: fine.version })).json().fine as TrafficFine;
    await call('POST', `/api/v1/receivables/${charged.receivable!.id}/payments`, {
      amountCents: charged.receivable!.grossAmountCents,
      paidAt: today,
      method: 'PIX',
      bankAccountId: await defaultAccountId(),
    });
    const paid = await getFine(fine.id);
    expect(paid.status).toBe('PAID');

    const canceled = await call('POST', `/api/v1/traffic-fines/${fine.id}/cancel`, { reason: 'Auto anulado pelo órgão', version: paid.version });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().status).toBe('CANCELED');

    const receivable = await harness.ctx.mongo.collections.receivables.findOne({ _id: new ObjectId(charged.receivable!.id) });
    expect(receivable?.status).toBe('CANCELED');
    const payments = await harness.ctx.mongo.collections.payments.find({ sourceId: receivable!._id }).toArray();
    expect(payments.every((p) => p.reversedAt)).toBe(true);

    // O mesmo AIT pode ser cadastrado de novo.
    const again = await call('POST', '/api/v1/traffic-fines', {
      vehicleId,
      aitNumber: fine.aitNumber,
      authorityName: 'DETRAN-SP',
      infractionDescription: 'Recadastro',
      occurredDate: addDaysIso(today, -1),
      occurredTime: '09:00',
      amountCents: 5000,
    });
    expect(again.statusCode).toBe(201);
  });

  /* --------------------------- indicação e recurso --------------------------- */
  it('indicação do condutor e depois cobrança', async () => {
    const { vehicleId } = await newRental();
    const fine = (await createFine(vehicleId)).json() as TrafficFine;
    const indicated = await call('POST', `/api/v1/traffic-fines/${fine.id}/indicate`, {
      protocol: 'FICI-2026-889',
      indicatedAt: today,
      version: fine.version,
    });
    expect(indicated.statusCode).toBe(200);
    expect(indicated.json().status).toBe('INDICATED');
    expect(indicated.json().indication).toEqual({ status: 'DONE', protocol: 'FICI-2026-889', indicatedAt: today });
    const charged = await call('POST', `/api/v1/traffic-fines/${fine.id}/charge`, { version: indicated.json().version });
    expect(charged.statusCode).toBe(201);
  });

  it('recurso indeferido volta ao estado anterior; deferido cancela a cobrança', async () => {
    const { vehicleId } = await newRental();
    const fine = (await createFine(vehicleId)).json() as TrafficFine;
    const charged = (await call('POST', `/api/v1/traffic-fines/${fine.id}/charge`, { version: fine.version })).json().fine as TrafficFine;

    const contested = (
      await call('POST', `/api/v1/traffic-fines/${fine.id}/contest`, { instance: 'DEFESA_PREVIA', filedAt: today, version: charged.version })
    ).json() as TrafficFine;
    expect(contested.status).toBe('CONTESTED');
    const denied = (
      await call('POST', `/api/v1/traffic-fines/${fine.id}/appeal-result`, { result: 'DENIED', version: contested.version })
    ).json() as TrafficFine;
    expect(denied.status).toBe('CHARGED');
    expect(denied.appeal.status).toBe('DENIED');

    const jari = (
      await call('POST', `/api/v1/traffic-fines/${fine.id}/contest`, { instance: 'JARI', filedAt: today, version: denied.version })
    ).json() as TrafficFine;
    const granted = await call('POST', `/api/v1/traffic-fines/${fine.id}/appeal-result`, { result: 'GRANTED', version: jari.version });
    expect(granted.json().status).toBe('CANCELED');
    const receivable = await harness.ctx.mongo.collections.receivables.findOne({ _id: new ObjectId(charged.receivable!.id) });
    expect(receivable?.status).toBe('CANCELED');
  });

  it('empresa assume a multa; transições inválidas são recusadas', async () => {
    const vehicleId = await newVehicle();
    const fine = (await createFine(vehicleId)).json() as TrafficFine;
    expect((await call('POST', `/api/v1/traffic-fines/${fine.id}/indicate`, { indicatedAt: today, version: fine.version })).statusCode).toBe(409);
    const liable = await call('POST', `/api/v1/traffic-fines/${fine.id}/company-liable`, { reason: 'Carro no pátio', version: fine.version });
    expect(liable.json().status).toBe('COMPANY_LIABLE');
    expect(liable.json().indication.status).toBe('NOT_REQUIRED');
    const cancel = await call('POST', `/api/v1/traffic-fines/${fine.id}/cancel`, { reason: 'x', version: liable.json().version });
    expect(cancel.statusCode).toBe(409);
  });

  it('cancelar a locação não cancela a multa cobrada do motorista', async () => {
    const { vehicleId, rentalId } = await newRental();
    const fine = (await createFine(vehicleId)).json() as TrafficFine;
    const charged = (await call('POST', `/api/v1/traffic-fines/${fine.id}/charge`, { version: fine.version })).json().fine as TrafficFine;
    expect((await call('DELETE', `/api/v1/rentals/${rentalId}`)).statusCode).toBe(200);
    const receivable = await harness.ctx.mongo.collections.receivables.findOne({ _id: new ObjectId(charged.receivable!.id) });
    expect(receivable?.status).not.toBe('CANCELED');
  });

  /* ------------------------------ aviso e lista ------------------------------ */
  it('aviso ao motorista sem provedor devolve o link manual do WhatsApp', async () => {
    const { vehicleId } = await newRental();
    const fine = (await createFine(vehicleId)).json() as TrafficFine;
    const res = await call('POST', `/api/v1/traffic-fines/${fine.id}/notify-driver`);
    expect(res.statusCode).toBe(200);
    expect(res.json().delivered).toBe(false);
    expect(res.json().manualLink).toMatch(/^https:\/\/wa\.me\/55/);
    expect(res.json().message).toContain(fine.aitNumber);
    expect((await getFine(fine.id)).history.at(-1)?.action).toBe('driver_notified');
  });

  it('lista com filtros, resumo e exportação CSV', async () => {
    const { vehicleId, driverId } = await newRental();
    const fine = (await createFine(vehicleId, { indicationDeadline: addDaysIso(today, -1) })).json() as TrafficFine;
    const byDriver = (await call('GET', `/api/v1/traffic-fines?driverId=${driverId}`)).json();
    expect(byDriver.data.map((f: TrafficFine) => f.id)).toEqual([fine.id]);
    const overdue = (await call('GET', '/api/v1/traffic-fines?deadline=overdue')).json();
    expect(overdue.data.some((f: TrafficFine) => f.id === fine.id)).toBe(true);
    expect(overdue.summary.indicationOverdueCount).toBeGreaterThan(0);
    const search = (await call('GET', `/api/v1/traffic-fines?q=${encodeURIComponent(fine.aitNumber)}`)).json();
    expect(search.data.map((f: TrafficFine) => f.id)).toContain(fine.id);

    const csv = await call('GET', `/api/v1/traffic-fines/export.csv?vehicleId=${vehicleId}`);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain(fine.aitNumber);
  });

  /* ------------------------------ prazos ------------------------------ */
  it('avisa o prazo de indicação sem duplicar e marca prazo perdido', async () => {
    const { vehicleId } = await newRental();
    const soon = (await createFine(vehicleId, { indicationDeadline: addDaysIso(today, 1) })).json() as TrafficFine;
    const late = (await createFine(vehicleId, { indicationDeadline: addDaysIso(today, -3) })).json() as TrafficFine;

    await generateFineNotifications(harness.ctx, orgId, today);
    await generateFineNotifications(harness.ctx, orgId, today);
    const notes = await harness.ctx.mongo.collections.notifications
      .find({ organizationId: orgId, type: 'FINE', entityId: { $in: [new ObjectId(soon.id), new ObjectId(late.id)] } })
      .toArray();
    expect(notes.filter((n) => n.title.startsWith('Indique'))).toHaveLength(1);
    expect(notes.filter((n) => n.title === 'Prazo de indicação perdido')).toHaveLength(1);
    expect(notes.every((n) => n.severity === 'CRITICAL')).toBe(true);
    expect((await getFine(late.id)).indication.status).toBe('MISSED');
    expect((await getFine(soon.id)).indication.status).toBe('PENDING');
    // Prazo perdido continua no filtro/contagem de "indicação vencida".
    const overdue = (await call('GET', `/api/v1/traffic-fines?deadline=overdue&vehicleId=${vehicleId}`)).json();
    expect(overdue.data.map((f: TrafficFine) => f.id)).toEqual([late.id]);
  });

  /* --------------------------- permissões e isolamento --------------------------- */
  it('respeita a permissão do módulo e isola empresas', async () => {
    const { vehicleId } = await newRental();
    const fine = (await createFine(vehicleId)).json() as TrafficFine;

    const noFines = await loginAs('sem-multas@exemplo.test', orgId, 'MEMBER', { vehicles: ['read'] });
    expect((await call('GET', '/api/v1/traffic-fines', undefined, noFines)).statusCode).toBe(403);

    const readOnly = await loginAs('multas-leitura@exemplo.test', orgId, 'MEMBER', { fines: ['read'] });
    expect((await call('GET', `/api/v1/traffic-fines/${fine.id}`, undefined, readOnly)).statusCode).toBe(200);
    expect((await call('POST', `/api/v1/traffic-fines/${fine.id}/charge`, { version: fine.version }, readOnly)).statusCode).toBe(403);

    const orgB = new ObjectId();
    const now = new Date();
    await harness.ctx.mongo.collections.organizations.insertOne({
      _id: orgB,
      name: 'Outra Locadora',
      legalId: null,
      timezone: 'America/Sao_Paulo',
      currency: 'BRL',
      settings: { freeSeats: 3, extraSeatPriceCents: 990 },
      createdAt: now,
      updatedAt: now,
    });
    const other = await loginAs('dono-outra@exemplo.test', orgB, 'OWNER', fullMatrix() as Record<string, string[]>);
    expect((await call('GET', `/api/v1/traffic-fines/${fine.id}`, undefined, other)).statusCode).toBe(404);
    expect((await call('POST', `/api/v1/traffic-fines/${fine.id}/cancel`, { reason: 'x', version: fine.version }, other)).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/traffic-fines', undefined, other)).json().data).toEqual([]);
  });
});
