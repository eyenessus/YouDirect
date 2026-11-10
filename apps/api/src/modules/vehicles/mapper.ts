import type { ObjectId } from 'mongodb';
import type { Vehicle } from '@yudirect/contracts';
import type { AppContext } from '../../context.js';
import type { VehicleDoc } from '../../database/types.js';
import { describeFiles } from '../../services/files.js';

export async function toVehicleDTO(
  ctx: AppContext,
  organizationId: ObjectId,
  doc: VehicleDoc,
): Promise<Vehicle> {
  const files = await describeFiles(ctx, organizationId, doc.photoFileIds ?? []);
  return {
    id: doc._id.toHexString(),
    plate: doc.plate,
    renavam: doc.renavam,
    vin: doc.vin,
    brand: doc.brand,
    model: doc.model,
    year: doc.year,
    color: doc.color,
    mileageKm: doc.mileageKm,
    registrationState: doc.registration?.state ?? null,
    registrationCity: doc.registration?.city ?? null,
    purchaseDate: doc.purchase?.date ?? null,
    purchaseAmountCents: doc.purchase?.amountCents ?? null,
    status: doc.status,
    photos: (doc.photoFileIds ?? [])
      .map((id) => files.get(id.toHexString()))
      .filter((f): f is NonNullable<typeof f> => Boolean(f))
      .map((f) => ({ fileId: f.id.toHexString(), url: f.url, originalName: f.originalName })),
    offer: doc.offer ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function toVehicleDTOs(
  ctx: AppContext,
  organizationId: ObjectId,
  docs: VehicleDoc[],
): Promise<Vehicle[]> {
  const allIds = docs.flatMap((d) => d.photoFileIds ?? []);
  const files = await describeFiles(ctx, organizationId, allIds);
  return docs.map((doc) => ({
    id: doc._id.toHexString(),
    plate: doc.plate,
    renavam: doc.renavam,
    vin: doc.vin,
    brand: doc.brand,
    model: doc.model,
    year: doc.year,
    color: doc.color,
    mileageKm: doc.mileageKm,
    registrationState: doc.registration?.state ?? null,
    registrationCity: doc.registration?.city ?? null,
    purchaseDate: doc.purchase?.date ?? null,
    purchaseAmountCents: doc.purchase?.amountCents ?? null,
    status: doc.status,
    photos: (doc.photoFileIds ?? [])
      .map((id) => files.get(id.toHexString()))
      .filter((f): f is NonNullable<typeof f> => Boolean(f))
      .map((f) => ({ fileId: f.id.toHexString(), url: f.url, originalName: f.originalName })),
    offer: doc.offer ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }));
}
