import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { addDaysIso, businessDate, type AvailabilityRow, type VehicleSwap } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';
import { processKmReading } from '../services/km-billing.js';

/** Carro reserva: troca temporária do veículo da locação e quadro de disponibilidade. */
describe('carro reserva', () => {
  let harness: TestHarness;
  let staff: string;
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
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  let seq = 0;
  const newVehicle = async (label = 'Reserva') => {
    seq += 1;
    const res = await call('POST', '/api/v1/vehicles', { plate: `RES${seq % 10}A${String(10 + seq)}`, brand: 'Fiat', model: `${label} ${seq}`, mileageKm: 100 }, staff);
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };
  const newRental = async () => {
    const vehicleId = await newVehicle('Titular');
    const driver = await call('POST', '/api/v1/drivers', { fullName: `Motorista Reserva ${seq}`, phone: `1144433${1000 + seq}` }, staff);
    const rental = await call('POST', '/api/v1/rentals', { vehicleId, driverId: driver.json().id, rentalType: 'WEEKLY', periodicAmountCents: 60000, depositCents: 0, startDate: addDaysIso(today, -10), endDate: addDaysIso(today, 18) }, staff);
    expect(rental.statusCode).toBe(201);
    return { vehicleId, rentalId: rental.json().id as string, driverId: driver.json().id as string };
  };
  const statusOf = async (vehicleId: string) => (await call('GET', `/api/v1/vehicles/${vehicleId}`, undefined, staff)).json().status as string;
  const swap = (rentalId: string, body: Record<string, unknown>) => call('POST', `/api/v1/rentals/${rentalId}/swap`, body, staff);

  it('exige sessão', async () => {
    expect((await call('GET', '/api/v1/vehicles/availability')).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/vehicle-swaps')).statusCode).toBe(401);
  });

  it('troca por manutenção: reserva fica locado, original vai para manutenção, e a devolução restaura tudo', async () => {
    const r = await newRental();
    const reserve = await newVehicle();
    expect(await statusOf(r.vehicleId)).toBe('RENTED');
    expect(await statusOf(reserve)).toBe('AVAILABLE');

    const res = await swap(r.rentalId, { replacementVehicleId: reserve, reason: 'MAINTENANCE', notes: 'Troca de embreagem' });
    expect(res.statusCode).toBe(201);
    const created = res.json() as VehicleSwap;
    expect(created).toMatchObject({ status: 'ACTIVE', reason: 'MAINTENANCE', startedOn: today });
    expect(created.original.id).toBe(r.vehicleId);
    expect(created.replacement.id).toBe(reserve);
    expect(created.driver?.id).toBe(r.driverId);
    expect(await statusOf(reserve)).toBe('RENTED');
    expect(await statusOf(r.vehicleId)).toBe('MAINTENANCE');

    const ended = await call('POST', `/api/v1/vehicle-swaps/${created.id}/end`, { originalReturned: true }, staff);
    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toMatchObject({ status: 'ENDED', endedOn: today });
    expect(await statusOf(reserve)).toBe('AVAILABLE');
    expect(await statusOf(r.vehicleId)).toBe('RENTED');
    // A locação nunca mudou de veículo.
    expect((await call('GET', `/api/v1/rentals/${r.rentalId}`, undefined, staff)).json().vehicle.id).toBe(r.vehicleId);
    expect((await call('POST', `/api/v1/vehicle-swaps/${created.id}/end`, {}, staff)).statusCode).toBe(409);
  });

  it('se o original não voltou, ele continua como está', async () => {
    const r = await newRental();
    const reserve = await newVehicle();
    const created = (await swap(r.rentalId, { replacementVehicleId: reserve, reason: 'CLAIM' })).json() as VehicleSwap;
    await call('POST', `/api/v1/vehicle-swaps/${created.id}/end`, { originalReturned: false }, staff);
    expect(await statusOf(reserve)).toBe('AVAILABLE');
    expect(await statusOf(r.vehicleId)).toBe('MAINTENANCE');
  });

  it('outro motivo libera o original em vez de mandar para manutenção', async () => {
    const r = await newRental();
    const reserve = await newVehicle();
    expect((await swap(r.rentalId, { replacementVehicleId: reserve, reason: 'OTHER' })).statusCode).toBe(201);
    expect(await statusOf(r.vehicleId)).toBe('AVAILABLE');
  });

  it('recusa reserva indisponível, igual ao titular, de locação sem ativa, ou já em uso', async () => {
    const r = await newRental();
    const reserve = await newVehicle();
    expect((await swap(r.rentalId, { replacementVehicleId: r.vehicleId, reason: 'OTHER' })).statusCode).toBe(422);
    expect((await swap(r.rentalId, { replacementVehicleId: new ObjectId().toHexString(), reason: 'OTHER' })).statusCode).toBe(404);
    const other = await newRental();
    // Veículo locado não serve de reserva.
    expect((await swap(r.rentalId, { replacementVehicleId: other.vehicleId, reason: 'MAINTENANCE' })).statusCode).toBe(409);
    expect((await swap(r.rentalId, { replacementVehicleId: reserve, reason: 'MAINTENANCE', startedOn: addDaysIso(today, 2) })).statusCode).toBe(422);

    expect((await swap(r.rentalId, { replacementVehicleId: reserve, reason: 'MAINTENANCE' })).statusCode).toBe(201);
    // A mesma locação não ganha um segundo reserva, e o reserva em uso não serve a outra locação.
    const reserve2 = await newVehicle();
    expect((await swap(r.rentalId, { replacementVehicleId: reserve2, reason: 'MAINTENANCE' })).statusCode).toBe(409);
    expect((await swap(other.rentalId, { replacementVehicleId: reserve, reason: 'MAINTENANCE' })).statusCode).toBe(409);

    await harness.ctx.mongo.collections.rentals.updateOne({ _id: new ObjectId(other.rentalId) }, { $set: { status: 'FINISHED' } });
    expect((await swap(other.rentalId, { replacementVehicleId: reserve2, reason: 'MAINTENANCE' })).statusCode).toBe(409);
  });

  it('lista as trocas por situação e por locação', async () => {
    const r = await newRental();
    const reserve = await newVehicle();
    const created = (await swap(r.rentalId, { replacementVehicleId: reserve, reason: 'MAINTENANCE' })).json() as VehicleSwap;
    const active = (await call('GET', '/api/v1/vehicle-swaps?status=ACTIVE', undefined, staff)).json().data as VehicleSwap[];
    expect(active.some((s) => s.id === created.id)).toBe(true);
    const byRental = (await call('GET', `/api/v1/vehicle-swaps?rentalId=${r.rentalId}`, undefined, staff)).json().data as VehicleSwap[];
    expect(byRental.map((s) => s.id)).toEqual([created.id]);
    const ended = (await call('GET', '/api/v1/vehicle-swaps?status=ENDED', undefined, staff)).json().data as VehicleSwap[];
    expect(ended.some((s) => s.id === created.id)).toBe(false);
  });

  it('o quadro de disponibilidade mostra quem usa, o reserva e quem pode servir de reserva', async () => {
    const r = await newRental();
    const free = await newVehicle('Livre');
    const reserve = await newVehicle('EmUso');
    const inShop = await newVehicle('Oficina');
    await call('POST', '/api/v1/claims', { vehicleId: inShop, occurredOn: today, kind: 'COLLISION', description: 'Colisão deixando o carro parado' }, staff);
    await swap(r.rentalId, { replacementVehicleId: reserve, reason: 'MAINTENANCE' });

    const rows = (await call('GET', '/api/v1/vehicles/availability', undefined, staff)).json().data as AvailabilityRow[];
    const row = (id: string) => rows.find((x) => x.vehicleId === id)!;
    expect(row(free)).toMatchObject({ status: 'AVAILABLE', usableAsReplacement: true, driverName: null });
    expect(row(reserve)).toMatchObject({ status: 'RENTED', usableAsReplacement: false });
    expect(row(reserve).asReplacementFor).toBe(row(r.vehicleId).plate);
    expect(row(reserve).driverName).toContain('Motorista Reserva');
    expect(row(r.vehicleId)).toMatchObject({ replacedBy: row(reserve).plate, usableAsReplacement: false });
    // Veículo disponível mas com sinistro em aberto não é oferecido.
    expect(row(inShop)).toMatchObject({ status: 'AVAILABLE', openClaims: 1, usableAsReplacement: false });
  });

  it('leitura de hodômetro de outro veículo nunca vira cobrança de km do contrato', async () => {
    const r = await newRental();
    const reserve = await newVehicle();
    const inspection = {
      _id: new ObjectId(),
      organizationId: (await harness.ctx.mongo.collections.rentals.findOne({ _id: new ObjectId(r.rentalId) }))!.organizationId,
      vehicleId: new ObjectId(reserve),
      rentalId: new ObjectId(r.rentalId),
      status: 'APPROVED',
      odometerKm: 99_999,
      submittedAt: new Date(),
    } as never;
    const res = await processKmReading(harness.ctx, inspection, null);
    expect(res).toEqual({ status: 'NOT_APPLICABLE', km: 0, amountCents: 0 });
  });
});
