import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { addDaysIso, businessDate, type FipeReportRow, type Vehicle } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { startFakeProviders, type FakeProviders } from '../testing/fake-providers.js';
import { seed } from '../database/seed.js';
import { FipeError, parseFipePrice } from '../integrations/fipe.js';
import { clearFipeCache, refreshStaleFipe } from '../services/fipe.js';

/** Valor de mercado (FIPE): vínculo, atualização, relatório e falhas do provedor. */
describe('tabela FIPE', () => {
  let harness: TestHarness;
  let fake: FakeProviders;
  let staff: string;
  let orgId: ObjectId;
  const today = businessDate();
  const link = { brandId: '21', modelId: '4828', yearId: '2022-1' };

  type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  const call = (method: Method, url: string, payload?: unknown, cookie?: string) =>
    harness.app.inject({
      method,
      url,
      headers: cookie ? { cookie } : {},
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  beforeAll(async () => {
    fake = await startFakeProviders();
    harness = await createHarness({ FIPE_API_URL: `${fake.url}/fipe` });
    await seed(harness.ctx);
    const login = await call('POST', '/api/v1/auth/login', { email: harness.env.SEED_OWNER_EMAIL, password: harness.env.SEED_OWNER_PASSWORD });
    staff = sessionCookie(login.headers as Record<string, unknown>);
    orgId = (await harness.ctx.mongo.collections.memberships.findOne({ role: 'OWNER' }))!.organizationId;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
    await fake?.close();
  });

  let seq = 0;
  const newVehicle = async (extra: Record<string, unknown> = {}) => {
    seq += 1;
    const res = await call('POST', '/api/v1/vehicles', { plate: `FIP${seq % 10}A${String(10 + seq)}`, brand: 'Fiat', model: `Mobi ${seq}`, mileageKm: 10, ...extra }, staff);
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };

  it('converte o preço da FIPE em centavos e recusa formatos estranhos', () => {
    expect(parseFipePrice('R$ 85.386,00')).toBe(8538600);
    expect(parseFipePrice('R$ 950,50')).toBe(95050);
    expect(parseFipePrice('R$ 1.234.567,89')).toBe(123456789);
    expect(() => parseFipePrice('85386')).toThrow(FipeError);
    expect(() => parseFipePrice('R$ 85.386')).toThrow(FipeError);
  });

  it('exige sessão', async () => {
    expect((await call('GET', '/api/v1/fipe/brands')).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/vehicles/fipe-report')).statusCode).toBe(401);
  });

  it('lista marcas, modelos e anos da FIPE e informa o estado da integração', async () => {
    clearFipeCache();
    expect((await call('GET', '/api/v1/fipe/status', undefined, staff)).json()).toMatchObject({ connected: true });
    const brands = (await call('GET', '/api/v1/fipe/brands', undefined, staff)).json().data;
    expect(brands).toContainEqual({ code: '21', name: 'Fiat' });
    expect((await call('GET', '/api/v1/fipe/brands/21/models', undefined, staff)).json().data[0]).toMatchObject({ code: '4828' });
    expect((await call('GET', '/api/v1/fipe/brands/21/models/4828/years', undefined, staff)).json().data[0]).toMatchObject({ code: '2022-1' });
    // Marca sem modelos na FIPE falsa: 404 claro.
    expect((await call('GET', '/api/v1/fipe/brands/99/models', undefined, staff)).statusCode).toBe(404);
  });

  it('as listas ficam em cache e não repetem a consulta', async () => {
    clearFipeCache();
    await call('GET', '/api/v1/fipe/brands', undefined, staff);
    const before = fake.requests.filter((r) => r.path === '/fipe/cars/brands').length;
    await call('GET', '/api/v1/fipe/brands', undefined, staff);
    await call('GET', '/api/v1/fipe/brands', undefined, staff);
    expect(fake.requests.filter((r) => r.path === '/fipe/cars/brands').length).toBe(before);
  });

  it('vincula o veículo à FIPE, guarda o valor em centavos e o histórico', async () => {
    const id = await newVehicle();
    const res = await call('POST', `/api/v1/vehicles/${id}/fipe`, link, staff);
    expect(res.statusCode).toBe(200);
    const vehicle = res.json() as Vehicle;
    expect(vehicle.fipe).toMatchObject({ priceCents: 6235000, codeFipe: '001478-1', referenceMonth: 'novembro de 2026', modelYear: 2022, link });
    expect(vehicle.fipe!.history).toEqual([{ referenceMonth: 'novembro de 2026', priceCents: 6235000 }]);
    expect((await call('GET', `/api/v1/vehicles/${id}`, undefined, staff)).json().fipe.priceCents).toBe(6235000);
  });

  it('recusa vínculo com ano inexistente, corpo inválido e veículo de outro lugar', async () => {
    const id = await newVehicle();
    expect((await call('POST', `/api/v1/vehicles/${id}/fipe`, { ...link, yearId: '1999-1' }, staff)).statusCode).toBe(404);
    expect((await call('POST', `/api/v1/vehicles/${id}/fipe`, { brandId: '', modelId: '4828', yearId: '2022-1' }, staff)).statusCode).toBe(422);
    expect((await call('POST', `/api/v1/vehicles/${new ObjectId().toHexString()}/fipe`, link, staff)).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/vehicles/${id}`, undefined, staff)).json().fipe ?? null).toBeNull();
  });

  it('atualizar sem vínculo é recusado; atualizar com vínculo troca o valor sem duplicar o mês', async () => {
    const id = await newVehicle();
    expect((await call('POST', `/api/v1/vehicles/${id}/fipe/refresh`, {}, staff)).statusCode).toBe(409);
    await call('POST', `/api/v1/vehicles/${id}/fipe`, link, staff);
    fake.fipePrices.set('21/4828/2022-1', 'R$ 60.100,00');
    const res = await call('POST', `/api/v1/vehicles/${id}/fipe/refresh`, {}, staff);
    expect(res.statusCode).toBe(200);
    expect(res.json().fipe.priceCents).toBe(6010000);
    expect(res.json().fipe.history).toHaveLength(1);
    fake.fipePrices.set('21/4828/2022-1', 'R$ 62.350,00');
  });

  it('desvincular remove o valor', async () => {
    const id = await newVehicle();
    await call('POST', `/api/v1/vehicles/${id}/fipe`, link, staff);
    expect((await call('DELETE', `/api/v1/vehicles/${id}/fipe`, undefined, staff)).statusCode).toBe(204);
    expect((await call('GET', `/api/v1/vehicles/${id}`, undefined, staff)).json().fipe ?? null).toBeNull();
  });

  it('falha do provedor vira erro claro e não grava valor', async () => {
    const id = await newVehicle();
    const original = harness.ctx.integrations.fipe;
    harness.ctx.integrations.fipe = { ...original, price: async () => { throw new FipeError('Limite de consultas à FIPE atingido. Tente novamente mais tarde.', 429); } };
    try {
      const res = await call('POST', `/api/v1/vehicles/${id}/fipe`, link, staff);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.message).toContain('Limite de consultas');
      expect((await call('GET', `/api/v1/vehicles/${id}`, undefined, staff)).json().fipe ?? null).toBeNull();
    } finally {
      harness.ctx.integrations.fipe = original;
    }
  });

  it('relatório: desvalorização sobre a compra e rendimento anual do aluguel semanal', async () => {
    const id = await newVehicle({ purchaseDate: '2025-01-10', purchaseAmountCents: 8000000 });
    await call('POST', `/api/v1/vehicles/${id}/fipe`, link, staff);
    const driver = await call('POST', '/api/v1/drivers', { fullName: 'Motorista FIPE', phone: '11933330001' }, staff);
    const rental = await call('POST', '/api/v1/rentals', { vehicleId: id, driverId: driver.json().id, rentalType: 'WEEKLY', periodicAmountCents: 60000, depositCents: 0, startDate: addDaysIso(today, -3), endDate: addDaysIso(today, 25) }, staff);
    expect(rental.statusCode).toBe(201);
    const noPrice = await newVehicle();
    await call('POST', `/api/v1/vehicles/${noPrice}/fipe`, link, staff);

    const rows = (await call('GET', '/api/v1/vehicles/fipe-report', undefined, staff)).json().data as FipeReportRow[];
    const mine = rows.find((r) => r.vehicleId === id)!;
    expect(mine).toMatchObject({ fipePriceCents: 6235000, purchaseAmountCents: 8000000, changeVsPurchasePercent: -22.1, weeklyRentCents: 60000, annualYieldPercent: 50 });
    // Sem preço de compra nem locação: sem percentuais, em vez de inventar.
    expect(rows.find((r) => r.vehicleId === noPrice)).toMatchObject({ changeVsPurchasePercent: null, weeklyRentCents: null, annualYieldPercent: null });
    // Quem mais desvalorizou aparece primeiro.
    expect(rows.findIndex((r) => r.vehicleId === id)).toBeLessThan(rows.findIndex((r) => r.vehicleId === noPrice));
  });

  it('o job atualiza só quem está sem consulta há mais de 25 dias, e uma falha não impede os demais', async () => {
    const stale = await newVehicle();
    const fresh = await newVehicle();
    await call('POST', `/api/v1/vehicles/${stale}/fipe`, link, staff);
    await call('POST', `/api/v1/vehicles/${fresh}/fipe`, link, staff);
    await harness.ctx.mongo.collections.vehicles.updateOne({ _id: new ObjectId(stale) }, { $set: { 'fipe.fetchedAt': new Date(Date.now() - 30 * 86_400_000), 'fipe.priceCents': 1 } });
    const res = await refreshStaleFipe(harness.ctx, orgId);
    expect(res.updated).toBeGreaterThanOrEqual(1);
    expect((await call('GET', `/api/v1/vehicles/${stale}`, undefined, staff)).json().fipe.priceCents).toBe(6235000);

    // Falha do provedor: conta como falha, mantém o valor antigo e não derruba o job.
    await harness.ctx.mongo.collections.vehicles.updateOne({ _id: new ObjectId(stale) }, { $set: { 'fipe.fetchedAt': new Date(Date.now() - 30 * 86_400_000), 'fipe.priceCents': 777 } });
    const original = harness.ctx.integrations.fipe;
    harness.ctx.integrations.fipe = { ...original, price: async () => { throw new FipeError('fora do ar', 500); } };
    try {
      const failed = await refreshStaleFipe(harness.ctx, orgId);
      expect(failed.failed).toBeGreaterThanOrEqual(1);
      expect((await harness.ctx.mongo.collections.vehicles.findOne({ _id: new ObjectId(stale) }))!.fipe!.priceCents).toBe(777);
    } finally {
      harness.ctx.integrations.fipe = original;
    }
  });
});
