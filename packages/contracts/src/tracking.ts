import { z } from 'zod';
import { isoDateTimeSchema, objectIdSchema } from './common.js';

/* ------------------------------------------------------------------ *
 * Rastreamento. O YuDirect não depende de um fabricante: qualquer
 * plataforma de rastreadores que consiga enviar um webhook JSON (ou um
 * integrador que você escreva) manda as posições para
 * POST /api/v1/webhooks/tracker com o token da empresa.
 *
 * O sistema mostra a última posição, avisa quando o carro sai das áreas
 * permitidas ou para de reportar e mantém o hodômetro em dia. Ele NÃO
 * bloqueia nem imobiliza veículo: isso exige contrato, aviso ao motorista
 * e validação jurídica, e fica fora do escopo.
 * ------------------------------------------------------------------ */

export const trackerPositionSchema = z.object({
  /** Identificador do rastreador na plataforma de origem (IMEI, serial...). */
  deviceId: z.string().trim().min(1).max(60),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** Momento da leitura (ISO com fuso). */
  at: z.string().datetime({ offset: true }),
  speedKmh: z.number().min(0).max(400).optional(),
  ignition: z.boolean().optional(),
  odometerKm: z.number().int().min(0).max(10_000_000).optional(),
});
export type TrackerPosition = z.infer<typeof trackerPositionSchema>;

export const TRACKER_BATCH_MAX = 100;
export const trackerIngestSchema = z.union([
  z.object({ positions: z.array(trackerPositionSchema).min(1).max(TRACKER_BATCH_MAX) }),
  trackerPositionSchema.transform((p) => ({ positions: [p] })),
]);

export const trackerIngestResultSchema = z.object({
  accepted: z.number().int(),
  duplicates: z.number().int(),
  unknownDevice: z.number().int(),
  rejected: z.number().int(),
});
export type TrackerIngestResult = z.infer<typeof trackerIngestResultSchema>;

export const trackerDeviceCreateSchema = z.object({
  vehicleId: objectIdSchema,
  deviceId: z.string().trim().min(1).max(60),
  label: z.string().trim().max(60).optional(),
});
export type TrackerDeviceCreate = z.infer<typeof trackerDeviceCreateSchema>;

export const geofenceCreateSchema = z.object({
  name: z.string().trim().min(2).max(60),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().int().min(100).max(200_000),
});
export type GeofenceCreate = z.infer<typeof geofenceCreateSchema>;

export const geofenceSchema = z.object({
  id: objectIdSchema,
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
  radiusM: z.number().int(),
});
export type Geofence = z.infer<typeof geofenceSchema>;

export const trackedVehicleSchema = z.object({
  vehicleId: objectIdSchema,
  plate: z.string(),
  label: z.string(),
  deviceId: z.string(),
  deviceLabel: z.string().nullable(),
  driverName: z.string().nullable(),
  position: z
    .object({
      lat: z.number(),
      lng: z.number(),
      at: isoDateTimeSchema,
      speedKmh: z.number().nullable(),
      ignition: z.boolean().nullable(),
      odometerKm: z.number().int().nullable(),
    })
    .nullable(),
  /** Minutos desde a última posição; null = nunca reportou. */
  minutesAgo: z.number().int().nullable(),
  /** Dentro de alguma área permitida; null = sem posição ou sem áreas cadastradas. */
  insideAllowedArea: z.boolean().nullable(),
  mapUrl: z.string().nullable(),
});
export type TrackedVehicle = z.infer<typeof trackedVehicleSchema>;

/** Horas sem reportar a partir das quais o carro locado gera alerta. */
export const TRACKER_SILENT_HOURS = 24;
/** Aceita leituras até 5 minutos no futuro (relógio do rastreador) e até 30 dias no passado (fila atrasada). */
export const TRACKER_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const TRACKER_MAX_AGE_DAYS = 30;

/** Distância em metros entre dois pontos (fórmula de haversine). */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function insideGeofence(point: { lat: number; lng: number }, zone: { lat: number; lng: number; radiusM: number }): boolean {
  return distanceMeters(point, zone) <= zone.radiusM;
}
