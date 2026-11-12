import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { addDaysIso, businessDate, type DriverRankingRow, type LoyaltyStatus } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';
import { recomputeLoyalty } from '../services/loyalty.js';

/** Pontuação do motorista: sinistros com culpa entram na conta e o ranking mostra quem precisa de atenção. */
describe('pontuação e ranking de motoristas', () => {
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
  const newDriver = async (name: string) => {
    seq += 1;
    const vehicle = await call('POST', '/api/v1/vehicles', { plate: `SCO${seq % 10}A${String(10 + seq)}`, brand: 'VW', model: `Polo ${seq}`, mileageKm: 1 }, staff);
    const driver = await call('POST', '/api/v1/drivers', { fullName: name, phone: `1155544${1000 + seq}` }, staff);
    const rental = await call('POST', '/api/v1/rentals', { vehicleId: vehicle.json().id, driverId: driver.json().id, rentalType: 'WEEKLY', periodicAmountCents: 60000, depositCents: 0, startDate: addDaysIso(today, -100), endDate: addDaysIso(today, 60) }, staff);
    expect(rental.statusCode).toBe(201);
    return { driverId: driver.json().id as string, vehicleId: vehicle.json().id as string, plate: vehicle.json().plate as string };
  };
  const claim = (vehicleId: string, fault: string, daysAgo = 5) =>
    call('POST', '/api/v1/claims', { vehicleId, occurredOn: addDaysIso(today, -daysAgo), kind: 'COLLISION', fault, description: 'Colisão para teste da pontuação' }, staff);
  const status = async (driverId: string) => (await call('GET', `/api/v1/drivers/${driverId}/loyalty`, undefined, staff)).json() as LoyaltyStatus;

  it('exige sessão para ver o ranking', async () => {
    expect((await call('GET', '/api/v1/drivers/ranking')).statusCode).toBe(401);
  });

  it('sinistro com culpa do motorista tira 40 pontos; de terceiro, cancelado não tiram', async () => {
    const d = await newDriver('Motorista Pontuação A');
    const before = await status(d.driverId);
    expect(before.criteria.find((c) => c.key === 'CLAIMS')).toMatchObject({ points: 0 });

    // Terceiro e a apurar não pesam.
    expect((await claim(d.vehicleId, 'THIRD_PARTY')).statusCode).toBe(201);
    expect((await claim(d.vehicleId, 'UNDETERMINED')).statusCode).toBe(201);
    expect((await status(d.driverId)).criteria.find((c) => c.key === 'CLAIMS')!.points).toBe(0);

    const mine = (await claim(d.vehicleId, 'DRIVER')).json();
    const after = await status(d.driverId);
    expect(after.criteria.find((c) => c.key === 'CLAIMS')).toMatchObject({ points: -40 });
    expect(after.score).toBe(Math.max(0, before.score - 40));

    // Cancelar devolve os pontos.
    await call('POST', `/api/v1/claims/${mine.id}/status`, { version: mine.version, status: 'CANCELED' }, staff);
    expect((await status(d.driverId)).criteria.find((c) => c.key === 'CLAIMS')!.points).toBe(0);
  });

  it('o desconto por sinistros tem teto de 80 pontos', async () => {
    const d = await newDriver('Motorista Pontuação B');
    for (let i = 0; i < 3; i += 1) expect((await claim(d.vehicleId, 'DRIVER', 3 + i)).statusCode).toBe(201);
    expect((await status(d.driverId)).criteria.find((c) => c.key === 'CLAIMS')!.points).toBe(-80);
  });

  it('o ranking lista quem tem locação ativa, do menor para o maior ponto, e marca quem precisa de atenção', async () => {
    const low = await newDriver('Motorista Ranking Baixo');
    const high = await newDriver('Motorista Ranking Alto');
    await harness.ctx.mongo.collections.drivers.updateOne({ _id: new ObjectId(low.driverId) }, { $set: { loyalty: { score: 5, levelCode: 'INICIAL', computedAt: new Date() } } });
    await harness.ctx.mongo.collections.drivers.updateOne({ _id: new ObjectId(high.driverId) }, { $set: { loyalty: { score: 260, levelCode: 'ESPECIAL', computedAt: new Date() } } });

    const res = (await call('GET', '/api/v1/drivers/ranking', undefined, staff)).json() as { data: DriverRankingRow[] };
    const scores = res.data.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
    const lowRow = res.data.find((r) => r.driverId === low.driverId)!;
    const highRow = res.data.find((r) => r.driverId === high.driverId)!;
    expect(lowRow).toMatchObject({ attention: true, levelName: 'Inicial', plate: low.plate });
    expect(highRow).toMatchObject({ attention: false, levelCode: 'ESPECIAL' });
    expect(res.data.indexOf(lowRow)).toBeLessThan(res.data.indexOf(highRow));
  });

  it('motorista sem locação ativa não entra no ranking', async () => {
    const d = await newDriver('Motorista Ranking Encerrado');
    await harness.ctx.mongo.collections.rentals.updateMany({ driverId: new ObjectId(d.driverId) }, { $set: { status: 'FINISHED' } });
    const res = (await call('GET', '/api/v1/drivers/ranking', undefined, staff)).json() as { data: DriverRankingRow[] };
    expect(res.data.some((r) => r.driverId === d.driverId)).toBe(false);
  });

  it('o job diário grava a pontuação já com os sinistros', async () => {
    const d = await newDriver('Motorista Job');
    await claim(d.vehicleId, 'DRIVER');
    await recomputeLoyalty(harness.ctx, orgId, today);
    const doc = await harness.ctx.mongo.collections.drivers.findOne({ _id: new ObjectId(d.driverId) });
    const live = await status(d.driverId);
    expect(doc?.loyalty?.score).toBe(live.score);
  });
});
