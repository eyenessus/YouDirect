import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { addDaysIso, businessDate, type Claim } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';
import { generateClaimNotifications } from '../services/claims.js';

/** Sinistros: registro, busca da locação vigente, andamento e cobrança da franquia. */
describe('sinistros', () => {
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

  beforeAll(async () => {
    harness = await createHarness();
    await seed(harness.ctx);
    const login = await call('POST', '/api/v1/auth/login', { email: harness.env.SEED_OWNER_EMAIL, password: harness.env.SEED_OWNER_PASSWORD });
    staff = sessionCookie(login.headers as Record<string, unknown>);
    orgId = (await harness.ctx.mongo.collections.memberships.findOne({ role: 'OWNER' }))!.organizationId;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  let seq = 0;
  const setup = async (withRental = true) => {
    seq += 1;
    const letters = 'ABCDEFGHIJ';
    const vehicle = await call('POST', '/api/v1/vehicles', { plate: `SIN${seq % 10}${letters[seq % 10]}${String(10 + seq)}`, brand: 'Hyundai', model: `HB20 ${seq}`, mileageKm: 1 }, staff);
    expect(vehicle.statusCode).toBe(201);
    const driver = await call('POST', '/api/v1/drivers', { fullName: `Motorista Sinistro ${seq}`, phone: `1188877${1000 + seq}` }, staff);
    let rentalId: string | null = null;
    if (withRental) {
      const rental = await call(
        'POST',
        '/api/v1/rentals',
        { vehicleId: vehicle.json().id, driverId: driver.json().id, rentalType: 'WEEKLY', periodicAmountCents: 60000, depositCents: 0, startDate: addDaysIso(today, -10), endDate: addDaysIso(today, 18) },
        staff,
      );
      expect(rental.statusCode).toBe(201);
      rentalId = rental.json().id;
    }
    return { vehicleId: vehicle.json().id as string, plate: vehicle.json().plate as string, driverId: driver.json().id as string, rentalId };
  };
  const open = (body: Record<string, unknown>) => call('POST', '/api/v1/claims', body, staff);

  it('exige sessão', async () => {
    expect((await call('GET', '/api/v1/claims')).statusCode).toBe(401);
    expect((await call('POST', '/api/v1/claims', {})).statusCode).toBe(401);
  });

  it('registra o sinistro achando sozinho a locação e o motorista da data', async () => {
    const s = await setup();
    const res = await open({ vehicleId: s.vehicleId, occurredOn: addDaysIso(today, -2), kind: 'COLLISION', description: 'Batida na traseira em semáforo', deductibleCents: 150000, policeReportNumber: 'BO-123' });
    expect(res.statusCode).toBe(201);
    const claim = res.json() as Claim;
    expect(claim.claimNumber).toMatch(/^SIN-\d{4}-\d+$/);
    expect(claim.status).toBe('OPEN');
    expect(claim.fault).toBe('UNDETERMINED');
    expect(claim.driver?.id).toBe(s.driverId);
    expect(claim.rental?.id).toBe(s.rentalId);
    expect(claim.vehicle.plate).toBe(s.plate);
    expect(claim.history[0]!.action).toBe('created');
  });

  it('data no futuro, veículo inexistente e locação de outro veículo são recusados', async () => {
    const s = await setup();
    const other = await setup();
    const base = { vehicleId: s.vehicleId, kind: 'THEFT', description: 'Furto do veículo na rua' };
    expect((await open({ ...base, occurredOn: addDaysIso(today, 3) })).statusCode).toBe(422);
    expect((await open({ ...base, vehicleId: new ObjectId().toHexString(), occurredOn: today })).statusCode).toBe(404);
    expect((await open({ ...base, occurredOn: today, rentalId: other.rentalId })).statusCode).toBe(422);
    expect((await open({ ...base, occurredOn: today, description: 'x' })).statusCode).toBe(422);
  });

  it('veículo sem locação na data vira sinistro sem motorista', async () => {
    const s = await setup(false);
    const claim = (await open({ vehicleId: s.vehicleId, occurredOn: today, kind: 'VANDALISM', description: 'Riscaram a lataria no estacionamento' })).json() as Claim;
    expect(claim.driver).toBeNull();
    expect(claim.rental).toBeNull();
    const charge = await call('POST', `/api/v1/claims/${claim.id}/charge`, { version: claim.version, amountCents: 50000 }, staff);
    expect(charge.statusCode).toBe(409);
  });

  it('lista e busca por placa, filtra por situação', async () => {
    const s = await setup();
    const created = (await open({ vehicleId: s.vehicleId, occurredOn: today, kind: 'GLASS', description: 'Para-brisa trincado por pedra' })).json() as Claim;
    const byPlate = (await call('GET', `/api/v1/claims?q=${s.plate.toLowerCase()}`, undefined, staff)).json().data as Claim[];
    expect(byPlate.map((c) => c.id)).toEqual([created.id]);
    const open2 = (await call('GET', '/api/v1/claims?status=OPEN', undefined, staff)).json().data as Claim[];
    expect(open2.some((c) => c.id === created.id)).toBe(true);
    const closed = (await call('GET', '/api/v1/claims?status=CLOSED', undefined, staff)).json().data as Claim[];
    expect(closed.some((c) => c.id === created.id)).toBe(false);
    expect((await call('GET', `/api/v1/claims/${created.id}`, undefined, staff)).json().id).toBe(created.id);
    expect((await call('GET', `/api/v1/claims/${new ObjectId().toHexString()}`, undefined, staff)).statusCode).toBe(404);
  });

  it('andamento: só avança, registra o histórico e protege contra edição simultânea', async () => {
    const s = await setup();
    const c0 = (await open({ vehicleId: s.vehicleId, occurredOn: today, kind: 'COLLISION', description: 'Colisão lateral no cruzamento' })).json() as Claim;
    const a = await call('POST', `/api/v1/claims/${c0.id}/status`, { version: c0.version, status: 'IN_ANALYSIS', note: 'Enviado à seguradora' }, staff);
    expect(a.statusCode).toBe(200);
    const c1 = a.json() as Claim;
    expect(c1.status).toBe('IN_ANALYSIS');
    expect(c1.history.at(-1)!.detail).toContain('Enviado à seguradora');
    // Versão velha: conflito.
    expect((await call('POST', `/api/v1/claims/${c0.id}/status`, { version: c0.version, status: 'IN_REPAIR' }, staff)).statusCode).toBe(409);
    // Não volta para Aberto.
    expect((await call('POST', `/api/v1/claims/${c0.id}/status`, { version: c1.version, status: 'OPEN' }, staff)).statusCode).toBe(409);
    const closed = (await call('POST', `/api/v1/claims/${c0.id}/status`, { version: c1.version, status: 'CLOSED' }, staff)).json() as Claim;
    expect(closed.status).toBe('CLOSED');
    // Encerrado não muda mais.
    expect((await call('PATCH', `/api/v1/claims/${c0.id}`, { version: closed.version, description: 'Nova descrição qualquer' }, staff)).statusCode).toBe(409);
    expect((await call('POST', `/api/v1/claims/${c0.id}/status`, { version: closed.version, status: 'CANCELED' }, staff)).statusCode).toBe(409);
  });

  it('atualiza dados e permite limpar um campo de texto', async () => {
    const s = await setup();
    const c0 = (await open({ vehicleId: s.vehicleId, occurredOn: today, kind: 'COLLISION', description: 'Colisão com poste na avenida', insurerClaimNumber: 'SEG-9', location: 'Av. Brasil' })).json() as Claim;
    const res = await call('PATCH', `/api/v1/claims/${c0.id}`, { version: c0.version, fault: 'DRIVER', location: '', finalCostCents: 320000, deductibleCents: 200000 }, staff);
    expect(res.statusCode).toBe(200);
    const c1 = res.json() as Claim;
    expect(c1).toMatchObject({ fault: 'DRIVER', location: null, finalCostCents: 320000, deductibleCents: 200000, insurerClaimNumber: 'SEG-9' });
    // Arquivo inexistente é recusado.
    expect((await call('PATCH', `/api/v1/claims/${c0.id}`, { version: c1.version, fileIds: [new ObjectId().toHexString()] }, staff)).statusCode).toBe(404);
  });

  it('cobra a franquia do motorista uma única vez, como avaria na conta a receber', async () => {
    const s = await setup();
    const c0 = (await open({ vehicleId: s.vehicleId, occurredOn: addDaysIso(today, -1), kind: 'COLLISION', description: 'Colisão por falta de atenção', fault: 'THIRD_PARTY', deductibleCents: 180000 })).json() as Claim;
    // Culpa de terceiro: não cobra o motorista.
    expect((await call('POST', `/api/v1/claims/${c0.id}/charge`, { version: c0.version }, staff)).statusCode).toBe(409);
    const c1 = (await call('PATCH', `/api/v1/claims/${c0.id}`, { version: c0.version, fault: 'DRIVER' }, staff)).json() as Claim;

    const charged = await call('POST', `/api/v1/claims/${c0.id}/charge`, { version: c1.version }, staff);
    expect(charged.statusCode).toBe(200);
    const body = charged.json() as { claim: Claim; alreadyCharged: boolean };
    expect(body.alreadyCharged).toBe(false);
    expect(body.claim.receivable).toMatchObject({ grossAmountCents: 180000, paidAmountCents: 0 });
    const rec = await harness.ctx.mongo.collections.receivables.findOne({ claimId: new ObjectId(c0.id) });
    expect(rec).toMatchObject({ kind: 'DAMAGE', driverId: new ObjectId(s.driverId), rentalId: new ObjectId(s.rentalId!) });
    expect(rec!.description).toContain(c0.claimNumber);

    // Repetir (duplo clique, versão velha) devolve a mesma cobrança sem criar outra.
    const again = await call('POST', `/api/v1/claims/${c0.id}/charge`, { version: c0.version }, staff);
    expect(again.statusCode).toBe(200);
    expect(again.json().alreadyCharged).toBe(true);
    expect(await harness.ctx.mongo.collections.receivables.countDocuments({ claimId: new ObjectId(c0.id) })).toBe(1);
  });

  it('a cobrança exige valor e vencimento válidos', async () => {
    const s = await setup();
    const c0 = (await open({ vehicleId: s.vehicleId, occurredOn: today, kind: 'COLLISION', description: 'Colisão sem franquia definida', fault: 'DRIVER' })).json() as Claim;
    // Sem franquia registrada e sem valor informado.
    expect((await call('POST', `/api/v1/claims/${c0.id}/charge`, { version: c0.version }, staff)).statusCode).toBe(422);
    expect((await call('POST', `/api/v1/claims/${c0.id}/charge`, { version: c0.version, amountCents: 0 }, staff)).statusCode).toBe(422);
    expect((await call('POST', `/api/v1/claims/${c0.id}/charge`, { version: c0.version, amountCents: 90000, dueDate: addDaysIso(today, -1) }, staff)).statusCode).toBe(422);
    const ok = await call('POST', `/api/v1/claims/${c0.id}/charge`, { version: c0.version, amountCents: 90000, dueDate: addDaysIso(today, 10) }, staff);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().claim.receivable.grossAmountCents).toBe(90000);
  });

  it('lembra a equipe de sinistro sem conclusão há mais de 15 dias, uma vez por semana', async () => {
    const s = await setup();
    const old = (await open({ vehicleId: s.vehicleId, occurredOn: addDaysIso(today, -20), kind: 'COLLISION', description: 'Colisão antiga ainda sem solução' })).json() as Claim;
    const recent = (await open({ vehicleId: s.vehicleId, occurredOn: addDaysIso(today, -3), kind: 'COLLISION', description: 'Colisão recente em análise' })).json() as Claim;
    await harness.ctx.mongo.collections.notifications.deleteMany({ entityType: 'claim' });
    expect(await generateClaimNotifications(harness.ctx, orgId, today)).toBeGreaterThanOrEqual(1);
    const notes = await harness.ctx.mongo.collections.notifications.find({ entityType: 'claim' }).toArray();
    expect(notes.some((n) => n.entityId?.equals(new ObjectId(old.id)))).toBe(true);
    expect(notes.some((n) => n.entityId?.equals(new ObjectId(recent.id)))).toBe(false);
    expect(await generateClaimNotifications(harness.ctx, orgId, today)).toBe(0);
    // Encerrado não é mais lembrado.
    await call('POST', `/api/v1/claims/${old.id}/status`, { version: old.version, status: 'CLOSED' }, staff);
    await harness.ctx.mongo.collections.notifications.deleteMany({ entityType: 'claim' });
    await generateClaimNotifications(harness.ctx, orgId, addDaysIso(today, 7));
    expect(await harness.ctx.mongo.collections.notifications.countDocuments({ entityId: new ObjectId(old.id) })).toBe(0);
  });
});
