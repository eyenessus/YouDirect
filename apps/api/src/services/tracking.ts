import { timingSafeEqual } from 'node:crypto';
import { ObjectId } from 'mongodb';
import {
  businessDate,
  insideGeofence,
  TRACKER_FUTURE_SKEW_MS,
  TRACKER_MAX_AGE_DAYS,
  TRACKER_SILENT_HOURS,
  type Geofence,
  type TrackedVehicle,
  type TrackerIngestResult,
  type TrackerPosition,
} from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { generateToken, sha256 } from '../common/helpers.js';
import type { GeofenceDoc, OrganizationDoc, VehicleDoc } from '../database/types.js';
import { audit } from './common.js';
import { createNotification, weekKey } from './notifications.js';

/* ------------------------------------------------------------------ *
 * Rastreamento: recebe posições de qualquer plataforma por webhook,
 * guarda a última posição e o histórico, mantém o hodômetro e avisa
 * quando o carro locado sai das áreas permitidas ou para de reportar.
 * Não bloqueia nem imobiliza veículo.
 * ------------------------------------------------------------------ */

interface Actor {
  organizationId: ObjectId;
  userId: ObjectId | null;
}

const TOKEN_PREFIX = 'ytk_';

/** Gera (ou troca) o token do webhook. O valor em claro só é devolvido agora; guardamos o hash. */
export async function rotateTrackerToken(ctx: AppContext, actor: Actor): Promise<string> {
  const token = `${TOKEN_PREFIX}${generateToken(24)}`;
  await ctx.mongo.collections.organizations.updateOne(
    { _id: actor.organizationId },
    { $set: { 'settings.tracker': { tokenHash: sha256(token), rotatedAt: new Date() }, updatedAt: new Date() } },
  );
  await audit(ctx, { organizationId: actor.organizationId, actorId: actor.userId, action: 'tracker.token_rotated', entityType: 'organization', entityId: actor.organizationId });
  return token;
}

/** Empresa dona do token, comparando o hash em tempo constante. */
export async function organizationByTrackerToken(ctx: AppContext, token: string | undefined): Promise<OrganizationDoc | null> {
  if (!token || !token.startsWith(TOKEN_PREFIX) || token.length > 120) return null;
  const hash = sha256(token);
  const org = await ctx.mongo.collections.organizations.findOne({ 'settings.tracker.tokenHash': hash });
  const stored = org?.settings.tracker?.tokenHash;
  if (!org || !stored) return null;
  return timingSafeEqual(Buffer.from(stored), Buffer.from(hash)) ? org : null;
}

export async function ingestPositions(ctx: AppContext, organizationId: ObjectId, positions: TrackerPosition[], now = new Date()): Promise<TrackerIngestResult> {
  const c = ctx.mongo.collections;
  const result: TrackerIngestResult = { accepted: 0, duplicates: 0, unknownDevice: 0, rejected: 0 };
  const devices = await c.trackerDevices.find({ organizationId, deviceId: { $in: [...new Set(positions.map((p) => p.deviceId))] } }).toArray();
  const deviceMap = new Map(devices.map((d) => [d.deviceId, d]));
  const newest = new Map<string, { vehicleId: ObjectId; position: TrackerPosition; at: Date }>();

  for (const p of positions) {
    const device = deviceMap.get(p.deviceId);
    if (!device) {
      result.unknownDevice += 1;
      continue;
    }
    const at = new Date(p.at);
    if (at.getTime() > now.getTime() + TRACKER_FUTURE_SKEW_MS || at.getTime() < now.getTime() - TRACKER_MAX_AGE_DAYS * 86_400_000) {
      result.rejected += 1;
      continue;
    }
    try {
      await c.vehiclePositions.insertOne({
        _id: new ObjectId(),
        organizationId,
        vehicleId: device.vehicleId,
        deviceId: p.deviceId,
        lat: p.lat,
        lng: p.lng,
        at,
        speedKmh: p.speedKmh ?? null,
        ignition: p.ignition ?? null,
        odometerKm: p.odometerKm ?? null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        result.duplicates += 1;
        continue;
      }
      throw err;
    }
    result.accepted += 1;
    const key = device.vehicleId.toHexString();
    if (!newest.has(key) || newest.get(key)!.at < at) newest.set(key, { vehicleId: device.vehicleId, position: p, at });
  }

  for (const { vehicleId, position, at } of newest.values()) {
    // Só avança a "última posição" (um lote atrasado não volta o carro no tempo).
    const updated = await c.vehicles.updateOne(
      { _id: vehicleId, organizationId, $or: [{ lastPosition: null }, { lastPosition: { $exists: false } }, { 'lastPosition.at': { $lt: at } }] },
      { $set: { lastPosition: { lat: position.lat, lng: position.lng, at, speedKmh: position.speedKmh ?? null, ignition: position.ignition ?? null, odometerKm: position.odometerKm ?? null }, updatedAt: now } },
    );
    if (position.odometerKm !== undefined) {
      await c.vehicles.updateOne({ _id: vehicleId, organizationId, mileageKm: { $lt: position.odometerKm } }, { $set: { mileageKm: position.odometerKm, updatedAt: now } });
    }
    if (updated.modifiedCount === 1) await checkGeofence(ctx, organizationId, vehicleId, position, now);
  }
  return result;
}

/** Aviso quando o carro locado está fora de todas as áreas permitidas (um por veículo por dia). */
async function checkGeofence(ctx: AppContext, organizationId: ObjectId, vehicleId: ObjectId, point: { lat: number; lng: number }, now: Date): Promise<void> {
  const c = ctx.mongo.collections;
  const zones = await c.geofences.find({ organizationId }).toArray();
  if (zones.length === 0) return;
  if (zones.some((z) => insideGeofence(point, z))) return;
  const vehicle = await c.vehicles.findOne({ _id: vehicleId, organizationId });
  if (!vehicle || vehicle.status !== 'RENTED') return;
  await createNotification(ctx, {
    organizationId,
    type: 'VEHICLE',
    severity: 'WARNING',
    title: 'Veículo fora da área permitida',
    message: `O veículo ${vehicle.plate} (${vehicle.brand} ${vehicle.model}) está fora das áreas permitidas. Última posição: ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}.`,
    subjectLabel: vehicle.plate,
    entityType: 'vehicle',
    entityId: vehicleId,
    targetPath: '/dashboard/vehicles/tracking',
    dedupeKey: `geofence:${vehicleId.toHexString()}:${businessDate(now)}`,
  });
}

/** Job: veículo locado com rastreador que não reporta há mais de 24 h (reaviso semanal). */
export async function generateTrackerNotifications(ctx: AppContext, organizationId: ObjectId, today = businessDate(), now = new Date()): Promise<number> {
  const c = ctx.mongo.collections;
  const devices = await c.trackerDevices.find({ organizationId }).toArray();
  if (devices.length === 0) return 0;
  const vehicles = await c.vehicles.find({ organizationId, archivedAt: null, status: 'RENTED', _id: { $in: devices.map((d) => d.vehicleId) } }).toArray();
  const limit = now.getTime() - TRACKER_SILENT_HOURS * 3600 * 1000;
  let created = 0;
  for (const v of vehicles) {
    const last = v.lastPosition?.at ?? null;
    if (last && last.getTime() >= limit) continue;
    const ok = await createNotification(ctx, {
      organizationId,
      type: 'VEHICLE',
      severity: 'WARNING',
      title: 'Rastreador sem sinal',
      message: last
        ? `O rastreador do ${v.plate} não reporta há mais de ${TRACKER_SILENT_HOURS} horas.`
        : `O rastreador do ${v.plate} nunca enviou posição.`,
      subjectLabel: v.plate,
      entityType: 'vehicle',
      entityId: v._id,
      targetPath: '/dashboard/vehicles/tracking',
      dedupeKey: `tracker-silent:${v._id.toHexString()}:${weekKey(today)}`,
    });
    if (ok) created += 1;
  }
  return created;
}

export const toGeofenceDTO = (z: GeofenceDoc): Geofence => ({ id: z._id.toHexString(), name: z.name, lat: z.lat, lng: z.lng, radiusM: z.radiusM });

export async function trackingOverview(ctx: AppContext, organizationId: ObjectId, now = new Date()): Promise<TrackedVehicle[]> {
  const c = ctx.mongo.collections;
  const devices = await c.trackerDevices.find({ organizationId }).toArray();
  const [vehicles, zones, rentals] = await Promise.all([
    c.vehicles.find({ organizationId, _id: { $in: devices.map((d) => d.vehicleId) } }).toArray(),
    c.geofences.find({ organizationId }).toArray(),
    c.rentals.find({ organizationId, status: 'ACTIVE', vehicleId: { $in: devices.map((d) => d.vehicleId) } }).toArray(),
  ]);
  const drivers = await c.drivers.find({ organizationId, _id: { $in: rentals.map((r) => r.driverId) } }, { projection: { fullName: 1 } }).toArray();
  const dName = new Map(drivers.map((d) => [d._id.toHexString(), d.fullName]));
  const vMap = new Map<string, VehicleDoc>(vehicles.map((v) => [v._id.toHexString(), v]));
  const rentalOf = new Map(rentals.map((r) => [r.vehicleId.toHexString(), r]));
  return devices
    .flatMap((d) => {
      const v = vMap.get(d.vehicleId.toHexString());
      if (!v) return [];
      const p = v.lastPosition ?? null;
      const rental = rentalOf.get(v._id.toHexString());
      return [
        {
          vehicleId: v._id.toHexString(),
          plate: v.plate,
          label: `${v.brand} ${v.model}`,
          deviceId: d.deviceId,
          deviceLabel: d.label,
          driverName: rental ? (dName.get(rental.driverId.toHexString()) ?? null) : null,
          position: p ? { lat: p.lat, lng: p.lng, at: p.at.toISOString(), speedKmh: p.speedKmh, ignition: p.ignition, odometerKm: p.odometerKm } : null,
          minutesAgo: p ? Math.max(0, Math.floor((now.getTime() - p.at.getTime()) / 60_000)) : null,
          insideAllowedArea: p && zones.length > 0 ? zones.some((z) => insideGeofence(p, z)) : null,
          mapUrl: p ? `https://www.google.com/maps?q=${p.lat},${p.lng}` : null,
        },
      ];
    })
    .sort((a, b) => (a.minutesAgo ?? Number.MAX_SAFE_INTEGER) - (b.minutesAgo ?? Number.MAX_SAFE_INTEGER));
}
