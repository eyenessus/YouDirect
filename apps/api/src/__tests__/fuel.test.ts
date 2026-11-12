import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { addDaysIso, businessDate, type FuelLog, type FuelSummary } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';
import { fuelStats } from '../services/fuel.js';

/** Abastecimento: registro, validação do hodômetro, consumo e custo por km. */
describe('abastecimento', () => {
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
  const newVehicle = async () => {
    seq += 1;
    const res = await call('POST', '/api/v1/vehicles', { plate: `FUE${seq % 10}A${String(10 + seq)}`, brand: 'Renault', model: `Kwid ${seq}`, mileageKm: 1000 }, staff);
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };
  const fill = (vehicleId: string, over: Record<string, unknown>) =>
    call('POST', '/api/v1/fuel-logs', { vehicleId, fuelType: 'GASOLINE', fullTank: true, ...over }, staff);

  it('exige sessão', async () => {
    expect((await call('GET', '/api/v1/fuel-logs')).statusCode).toBe(401);
  });

  it('o cálculo usa o método do tanque cheio e ignora o 1º abastecimento nos litros', () => {
    const stats = fuelStats([
      { date: '2026-10-01', liters: 40, totalCents: 24000, odometerKm: 1000, fullTank: true },
      { date: '2026-10-08', liters: 30, totalCents: 18000, odometerKm: 1300, fullTank: false },
      { date: '2026-10-15', liters: 20, totalCents: 12000, odometerKm: 1500, fullTank: true },
    ]);
    // 500 km com 30 + 20 litros (o primeiro enchimento só zera a base): 10 km/l, R$ 0,60 por km.
    expect(stats).toMatchObject({ fills: 3, liters: 90, totalCents: 54000, distanceKm: 500, kmPerLiter: 10 });
    expect(stats.costPerKmCents).toBe(60);
    // Só um tanque cheio: sem consumo.
    expect(fuelStats([{ date: '2026-10-01', liters: 40, totalCents: 24000, odometerKm: 1000, fullTank: true }])).toMatchObject({ kmPerLiter: null, costPerKmCents: null, distanceKm: null });
    expect(fuelStats([])).toMatchObject({ fills: 0, totalCents: 0 });
  });

  it('registra o abastecimento, acha o motorista da locação e atualiza o hodômetro do veículo', async () => {
    const vehicleId = await newVehicle();
    const driver = await call('POST', '/api/v1/drivers', { fullName: 'Motorista Combustível', phone: '11966660001' }, staff);
    const rental = await call('POST', '/api/v1/rentals', { vehicleId, driverId: driver.json().id, rentalType: 'WEEKLY', periodicAmountCents: 60000, depositCents: 0, startDate: addDaysIso(today, -10), endDate: addDaysIso(today, 18) }, staff);
    expect(rental.statusCode).toBe(201);
    const res = await fill(vehicleId, { date: addDaysIso(today, -3), liters: 38.5, totalCents: 23100, odometerKm: 1250, station: 'Posto Central' });
    expect(res.statusCode).toBe(201);
    const log = res.json() as FuelLog;
    expect(log.driver?.id).toBe(driver.json().id);
    expect(log.pricePerLiterCents).toBe(600);
    expect(log.liters).toBe(38.5);
    expect((await call('GET', `/api/v1/vehicles/${vehicleId}`, undefined, staff)).json().mileageKm).toBe(1250);
  });

  it('recusa data futura, litros/valor inválidos e hodômetro fora de ordem', async () => {
    const vehicleId = await newVehicle();
    expect((await fill(vehicleId, { date: addDaysIso(today, 1), liters: 30, totalCents: 18000, odometerKm: 1100 })).statusCode).toBe(422);
    expect((await fill(vehicleId, { date: today, liters: 0, totalCents: 18000, odometerKm: 1100 })).statusCode).toBe(422);
    expect((await fill(vehicleId, { date: today, liters: 30, totalCents: 0, odometerKm: 1100 })).statusCode).toBe(422);
    expect((await fill(new ObjectId().toHexString(), { date: today, liters: 30, totalCents: 18000, odometerKm: 1100 })).statusCode).toBe(404);

    expect((await fill(vehicleId, { date: addDaysIso(today, -10), liters: 30, totalCents: 18000, odometerKm: 1100 })).statusCode).toBe(201);
    expect((await fill(vehicleId, { date: addDaysIso(today, -2), liters: 30, totalCents: 18000, odometerKm: 1500 })).statusCode).toBe(201);
    // Depois do primeiro mas com hodômetro menor: recusa.
    const lower = await fill(vehicleId, { date: addDaysIso(today, -5), liters: 30, totalCents: 18000, odometerKm: 1050 });
    expect(lower.statusCode).toBe(422);
    expect(lower.json().error.message).toContain('menor');
    // Entre os dois datas, mas acima do seguinte: recusa.
    const higher = await fill(vehicleId, { date: addDaysIso(today, -5), liters: 30, totalCents: 18000, odometerKm: 1600 });
    expect(higher.statusCode).toBe(422);
    expect(higher.json().error.message).toContain('maior');
    // Entre os dois: aceita.
    expect((await fill(vehicleId, { date: addDaysIso(today, -5), liters: 30, totalCents: 18000, odometerKm: 1300 })).statusCode).toBe(201);
  });

  it('resume por veículo com consumo e custo por km e lista os mais gastos primeiro', async () => {
    const vehicleId = await newVehicle();
    await fill(vehicleId, { date: addDaysIso(today, -20), liters: 40, totalCents: 24000, odometerKm: 2000 });
    await fill(vehicleId, { date: addDaysIso(today, -10), liters: 25, totalCents: 15000, odometerKm: 2300 });
    await fill(vehicleId, { date: addDaysIso(today, -2), liters: 25, totalCents: 15000, odometerKm: 2550 });
    const res = (await call('GET', '/api/v1/fuel-logs/summary?days=90', undefined, staff)).json() as { data: FuelSummary[] };
    const mine = res.data.find((s) => s.vehicleId === vehicleId)!;
    expect(mine).toMatchObject({ fills: 3, distanceKm: 550, totalCents: 54000 });
    expect(mine.kmPerLiter).toBe(11);
    expect(mine.costPerKmCents).toBe(54.55);
    const totals = res.data.map((s) => s.totalCents);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    // Fora do período não entra.
    const short = (await call('GET', '/api/v1/fuel-logs/summary?days=7', undefined, staff)).json() as { data: FuelSummary[] };
    expect(short.data.find((s) => s.vehicleId === vehicleId)?.fills).toBe(1);
  });

  it('lista por veículo e exclui um abastecimento', async () => {
    const vehicleId = await newVehicle();
    const created = (await fill(vehicleId, { date: today, liters: 30, totalCents: 18000, odometerKm: 1100 })).json() as FuelLog;
    const list = (await call('GET', `/api/v1/fuel-logs?vehicleId=${vehicleId}`, undefined, staff)).json().data as FuelLog[];
    expect(list.map((l) => l.id)).toEqual([created.id]);
    expect((await call('DELETE', `/api/v1/fuel-logs/${created.id}`, undefined, staff)).statusCode).toBe(204);
    expect((await call('GET', `/api/v1/fuel-logs?vehicleId=${vehicleId}`, undefined, staff)).json().data).toEqual([]);
    expect((await call('DELETE', `/api/v1/fuel-logs/${created.id}`, undefined, staff)).statusCode).toBe(404);
  });
});
