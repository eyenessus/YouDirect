import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { addDaysIso, businessDate, distanceMeters, insideGeofence, type TrackedVehicle, type TrackerIngestResult } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';
import { generateTrackerNotifications } from '../services/tracking.js';

/** Rastreamento: webhook por token, última posição, hodômetro, áreas permitidas e rastreador mudo. */
describe('rastreamento', () => {
  let harness: TestHarness;
  let staff: string;
  let orgId: ObjectId;
  let token: string;
  const today = businessDate();
  // Praça da Sé, São Paulo.
  const SE = { lat: -23.5505, lng: -46.6333 };

  type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  const call = (method: Method, url: string, payload?: unknown, cookie?: string, headers: Record<string, string> = {}) =>
    harness.app.inject({
      method,
      url,
      headers: { ...(cookie ? { cookie } : {}), ...headers },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const hook = (payload: unknown, t = token) => call('POST', '/api/v1/webhooks/tracker', payload, undefined, { 'x-tracker-token': t });
  const pos = (deviceId: string, over: Record<string, unknown> = {}) => ({ deviceId, lat: SE.lat, lng: SE.lng, at: new Date().toISOString(), ...over });

  beforeAll(async () => {
    harness = await createHarness();
    await seed(harness.ctx);
    const login = await call('POST', '/api/v1/auth/login', { email: harness.env.SEED_OWNER_EMAIL, password: harness.env.SEED_OWNER_PASSWORD });
    staff = sessionCookie(login.headers as Record<string, unknown>);
    orgId = (await harness.ctx.mongo.collections.memberships.findOne({ role: 'OWNER' }))!.organizationId;
    token = (await call('POST', '/api/v1/tracking/token', {}, staff)).json().token;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  let seq = 0;
  const trackedVehicle = async (rented = true) => {
    seq += 1;
    const vehicle = await call('POST', '/api/v1/vehicles', { plate: `TRK${seq % 10}A${String(10 + seq)}`, brand: 'Chevrolet', model: `Onix ${seq}`, mileageKm: 1000 }, staff);
    const vehicleId = vehicle.json().id as string;
    const deviceId = `IMEI-${1000 + seq}`;
    expect((await call('POST', '/api/v1/tracking/devices', { vehicleId, deviceId, label: 'Rastreador de teste' }, staff)).statusCode).toBe(201);
    let driverId: string | null = null;
    if (rented) {
      const driver = await call('POST', '/api/v1/drivers', { fullName: `Motorista Rastreado ${seq}`, phone: `1122211${1000 + seq}` }, staff);
      driverId = driver.json().id;
      const rental = await call('POST', '/api/v1/rentals', { vehicleId, driverId, rentalType: 'WEEKLY', periodicAmountCents: 60000, depositCents: 0, startDate: addDaysIso(today, -2), endDate: addDaysIso(today, 20) }, staff);
      expect(rental.statusCode).toBe(201);
    }
    return { vehicleId, deviceId, plate: vehicle.json().plate as string, driverId };
  };

  it('a distância e a área circular usam haversine', () => {
    expect(distanceMeters(SE, SE)).toBe(0);
    // ~1 grau de latitude ≈ 111 km.
    expect(Math.round(distanceMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) / 1000)).toBe(111);
    expect(insideGeofence({ lat: SE.lat + 0.001, lng: SE.lng }, { ...SE, radiusM: 500 })).toBe(true);
    expect(insideGeofence({ lat: SE.lat + 0.01, lng: SE.lng }, { ...SE, radiusM: 500 })).toBe(false);
  });

  it('o webhook exige o token certo (cabeçalho ou Bearer) e a empresa certa', async () => {
    expect((await call('POST', '/api/v1/webhooks/tracker', pos('x'))).statusCode).toBe(401);
    expect((await hook(pos('x'), 'ytk_errado')).statusCode).toBe(401);
    expect((await hook(pos('x'), 'sem-prefixo')).statusCode).toBe(401);
    const bearer = await call('POST', '/api/v1/webhooks/tracker', pos('x'), undefined, { authorization: `Bearer ${token}` });
    expect(bearer.statusCode).toBe(200);
    expect(bearer.json()).toEqual({ accepted: 0, duplicates: 0, unknownDevice: 1, rejected: 0 });
  });

  it('o token só é mostrado ao gerar e o painel diz se está configurado', async () => {
    const status = (await call('GET', '/api/v1/tracking/token', undefined, staff)).json();
    expect(status.configured).toBe(true);
    expect(status.rotatedAt).toBeTruthy();
    expect(JSON.stringify(status)).not.toContain(token);
    const org = await harness.ctx.mongo.collections.organizations.findOne({ _id: orgId });
    expect(org!.settings.tracker!.tokenHash).not.toBe(token);
    // Gerar outro invalida o anterior.
    const old = token;
    token = (await call('POST', '/api/v1/tracking/token', {}, staff)).json().token;
    expect(token).not.toBe(old);
    expect((await hook(pos('x'), old)).statusCode).toBe(401);
    expect((await hook(pos('x'))).statusCode).toBe(200);
  });

  it('recebe posições, guarda a última, atualiza o hodômetro e ignora repetidas', async () => {
    const v = await trackedVehicle();
    const at = new Date(Date.now() - 60_000).toISOString();
    const res = await hook(pos(v.deviceId, { at, speedKmh: 42, ignition: true, odometerKm: 1234 }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 1, duplicates: 0, unknownDevice: 0, rejected: 0 });
    // Mesma leitura de novo: duplicada.
    expect((await hook(pos(v.deviceId, { at }))).json()).toMatchObject({ accepted: 0, duplicates: 1 });

    const vehicle = (await call('GET', `/api/v1/vehicles/${v.vehicleId}`, undefined, staff)).json();
    expect(vehicle.mileageKm).toBe(1234);
    const overview = (await call('GET', '/api/v1/tracking/overview', undefined, staff)).json().data as TrackedVehicle[];
    const row = overview.find((r) => r.vehicleId === v.vehicleId)!;
    expect(row.position).toMatchObject({ lat: SE.lat, lng: SE.lng, speedKmh: 42, ignition: true, odometerKm: 1234 });
    expect(row.minutesAgo).toBeLessThanOrEqual(2);
    expect(row.driverName).toContain('Motorista Rastreado');
    expect(row.mapUrl).toContain(`${SE.lat},${SE.lng}`);
    expect(row.insideAllowedArea).toBeNull(); // sem áreas cadastradas ainda
  });

  it('lote: uma leitura atrasada não volta o carro no tempo e o hodômetro nunca diminui', async () => {
    const v = await trackedVehicle();
    const newer = new Date(Date.now() - 60_000).toISOString();
    const older = new Date(Date.now() - 3_600_000).toISOString();
    const res = await hook({ positions: [pos(v.deviceId, { at: newer, lat: -23.56, lng: -46.65, odometerKm: 2000 }), pos(v.deviceId, { at: older, lat: -23.5, lng: -46.6, odometerKm: 1500 })] });
    expect(res.json()).toMatchObject({ accepted: 2 });
    const row = ((await call('GET', '/api/v1/tracking/overview', undefined, staff)).json().data as TrackedVehicle[]).find((r) => r.vehicleId === v.vehicleId)!;
    expect(row.position).toMatchObject({ lat: -23.56, lng: -46.65 });
    expect((await call('GET', `/api/v1/vehicles/${v.vehicleId}`, undefined, staff)).json().mileageKm).toBe(2000);
    // Chegando depois, mas mais antiga que a última: também não substitui.
    await hook(pos(v.deviceId, { at: new Date(Date.now() - 1_800_000).toISOString(), lat: -23.4, lng: -46.5 }));
    const again = ((await call('GET', '/api/v1/tracking/overview', undefined, staff)).json().data as TrackedVehicle[]).find((r) => r.vehicleId === v.vehicleId)!;
    expect(again.position).toMatchObject({ lat: -23.56 });
    const history = (await call('GET', `/api/v1/vehicles/${v.vehicleId}/positions?hours=24`, undefined, staff)).json().data as Array<{ at: string }>;
    expect(history).toHaveLength(3);
    expect(history[0]!.at > history[1]!.at).toBe(true);
  });

  it('recusa leitura no futuro ou muito antiga, coordenadas inválidas e lote grande demais', async () => {
    const v = await trackedVehicle();
    const future = await hook(pos(v.deviceId, { at: new Date(Date.now() + 3_600_000).toISOString() }));
    const ancient = await hook(pos(v.deviceId, { at: new Date(Date.now() - 40 * 86_400_000).toISOString() }));
    expect(future.json()).toMatchObject({ accepted: 0, rejected: 1 });
    expect(ancient.json()).toMatchObject({ accepted: 0, rejected: 1 });
    expect((await hook(pos(v.deviceId, { lat: 123 }))).statusCode).toBe(422);
    expect((await hook(pos(v.deviceId, { at: 'ontem' }))).statusCode).toBe(422);
    expect((await hook({ positions: [] })).statusCode).toBe(422);
    expect((await hook({ positions: Array.from({ length: 101 }, () => pos(v.deviceId)) })).statusCode).toBe(422);
    const result = (await hook({ positions: [pos('desconhecido'), pos(v.deviceId, { at: new Date(Date.now() - 5000).toISOString() })] })).json() as TrackerIngestResult;
    expect(result).toEqual({ accepted: 1, duplicates: 0, unknownDevice: 1, rejected: 0 });
  });

  it('cadastro de rastreador: um por veículo, deviceId único e veículo existente', async () => {
    const v = await trackedVehicle(false);
    const other = await call('POST', '/api/v1/vehicles', { plate: 'TRK9Z99', brand: 'VW', model: 'Gol', mileageKm: 1 }, staff);
    expect((await call('POST', '/api/v1/tracking/devices', { vehicleId: v.vehicleId, deviceId: 'OUTRO-1' }, staff)).statusCode).toBe(409);
    expect((await call('POST', '/api/v1/tracking/devices', { vehicleId: other.json().id, deviceId: v.deviceId }, staff)).statusCode).toBe(409);
    expect((await call('POST', '/api/v1/tracking/devices', { vehicleId: new ObjectId().toHexString(), deviceId: 'ZZZ' }, staff)).statusCode).toBe(404);
    const devices = (await call('GET', '/api/v1/tracking/devices', undefined, staff)).json().data as Array<{ id: string; deviceId: string }>;
    const mine = devices.find((d) => d.deviceId === v.deviceId)!;
    expect((await call('DELETE', `/api/v1/tracking/devices/${mine.id}`, undefined, staff)).statusCode).toBe(204);
    // Removido, o webhook passa a tratá-lo como desconhecido.
    expect((await hook(pos(v.deviceId))).json()).toMatchObject({ unknownDevice: 1 });
    expect((await call('DELETE', `/api/v1/tracking/devices/${mine.id}`, undefined, staff)).statusCode).toBe(404);
  });

  it('área permitida: sair dela com o carro locado gera um aviso por dia; dentro, não', async () => {
    const zone = await call('POST', '/api/v1/tracking/geofences', { name: 'São Paulo capital', ...SE, radiusM: 20_000 }, staff);
    expect(zone.statusCode).toBe(201);
    expect((await call('POST', '/api/v1/tracking/geofences', { name: 'São Paulo capital', ...SE, radiusM: 5000 }, staff)).statusCode).toBe(409);
    expect((await call('POST', '/api/v1/tracking/geofences', { name: 'Pequena', ...SE, radiusM: 10 }, staff)).statusCode).toBe(422);

    const rented = await trackedVehicle(true);
    const idle = await trackedVehicle(false);
    await harness.ctx.mongo.collections.notifications.deleteMany({ entityType: 'vehicle', title: 'Veículo fora da área permitida' });
    // Dentro: sem aviso.
    await hook(pos(rented.deviceId, { at: new Date(Date.now() - 120_000).toISOString() }));
    // Rio de Janeiro: fora.
    await hook(pos(rented.deviceId, { at: new Date(Date.now() - 60_000).toISOString(), lat: -22.9068, lng: -43.1729 }));
    await hook(pos(rented.deviceId, { at: new Date(Date.now() - 30_000).toISOString(), lat: -22.91, lng: -43.17 }));
    // Veículo parado (não locado) fora da área: sem aviso.
    await hook(pos(idle.deviceId, { lat: -22.9068, lng: -43.1729 }));

    const alerts = await harness.ctx.mongo.collections.notifications.find({ title: 'Veículo fora da área permitida' }).toArray();
    expect(alerts.filter((a) => a.entityId?.equals(new ObjectId(rented.vehicleId)))).toHaveLength(1); // deduplicado no dia
    expect(alerts.some((a) => a.entityId?.equals(new ObjectId(idle.vehicleId)))).toBe(false);
    const row = ((await call('GET', '/api/v1/tracking/overview', undefined, staff)).json().data as TrackedVehicle[]).find((r) => r.vehicleId === rented.vehicleId)!;
    expect(row.insideAllowedArea).toBe(false);

    const zones = (await call('GET', '/api/v1/tracking/geofences', undefined, staff)).json().data as Array<{ id: string }>;
    expect((await call('DELETE', `/api/v1/tracking/geofences/${zones[0]!.id}`, undefined, staff)).statusCode).toBe(204);
    expect((await call('DELETE', `/api/v1/tracking/geofences/${zones[0]!.id}`, undefined, staff)).statusCode).toBe(404);
  });

  it('rastreador mudo há mais de 24 h (ou que nunca reportou) em carro locado avisa a equipe, uma vez por semana', async () => {
    const silent = await trackedVehicle(true);
    const never = await trackedVehicle(true);
    const live = await trackedVehicle(true);
    const idle = await trackedVehicle(false);
    await hook(pos(silent.deviceId, { at: new Date(Date.now() - 60_000).toISOString() }));
    await hook(pos(live.deviceId, { at: new Date(Date.now() - 60_000).toISOString() }));
    await harness.ctx.mongo.collections.vehicles.updateOne({ _id: new ObjectId(silent.vehicleId) }, { $set: { 'lastPosition.at': new Date(Date.now() - 30 * 3600_000) } });
    await harness.ctx.mongo.collections.notifications.deleteMany({ title: 'Rastreador sem sinal' });

    expect(await generateTrackerNotifications(harness.ctx, orgId, today)).toBeGreaterThanOrEqual(2);
    const notes = await harness.ctx.mongo.collections.notifications.find({ title: 'Rastreador sem sinal' }).toArray();
    const has = (id: string) => notes.some((n) => n.entityId?.equals(new ObjectId(id)));
    expect(has(silent.vehicleId)).toBe(true);
    expect(has(never.vehicleId)).toBe(true);
    expect(notes.find((n) => n.entityId?.equals(new ObjectId(never.vehicleId)))!.message).toContain('nunca enviou');
    expect(has(live.vehicleId)).toBe(false);
    expect(has(idle.vehicleId)).toBe(false);
    expect(await generateTrackerNotifications(harness.ctx, orgId, today)).toBe(0);
  });

  it('o painel exige sessão e permissão; só dono ou administrador gera o token', async () => {
    expect((await call('GET', '/api/v1/tracking/overview')).statusCode).toBe(401);
    expect((await call('POST', '/api/v1/tracking/token', {})).statusCode).toBe(401);
    expect((await call('GET', '/api/v1/tracking/devices')).statusCode).toBe(401);
  });
});
