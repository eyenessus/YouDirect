import { ObjectId } from 'mongodb';
import type { ContractSignature } from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { conflict, integrationUnavailable, notFound } from '../common/errors.js';
import type { ContractSignatureDoc, RentalDoc } from '../database/types.js';
import { renderRentalContract, type RentalContractData } from '../pdf/rental-contract.js';
import { audit } from './common.js';
import { describeFiles, storeFile } from './files.js';
import { createNotification } from './notifications.js';

/* ------------------------------------------------------------------ *
 * Contrato de locação: PDF gerado dos dados da locação e enviado para
 * assinatura digital com selfie + foto da CNH (ZapSign). Ao assinar,
 * o PDF assinado vira o contrato anexado da locação.
 * ------------------------------------------------------------------ */

export async function contractData(ctx: AppContext, rental: RentalDoc): Promise<RentalContractData> {
  const c = ctx.mongo.collections;
  const [org, driver, vehicle] = await Promise.all([
    c.organizations.findOne({ _id: rental.organizationId }),
    c.drivers.findOne({ _id: rental.driverId, organizationId: rental.organizationId }),
    c.vehicles.findOne({ _id: rental.vehicleId, organizationId: rental.organizationId }),
  ]);
  if (!org || !driver || !vehicle) throw notFound('Dados da locação incompletos.');
  const a = driver.address;
  const address = [a.street, a.number, a.complement, a.district, a.city && a.state ? `${a.city}/${a.state}` : a.city].filter(Boolean).join(', ');
  return {
    organization: { name: org.name, legalId: org.legalId, city: org.settings.publicSite?.city ?? null },
    rental: {
      rentalNumber: rental.rentalNumber,
      rentalType: rental.rentalType,
      startDate: rental.startDate,
      endDate: rental.endDate,
      periodicAmountCents: rental.periodicAmountCents,
      depositCents: rental.depositCents,
      weeklyFranchiseKm: rental.kmPolicy?.weeklyFranchiseKm ?? null,
      extraKmPriceCents: rental.kmPolicy?.extraKmPriceCents ?? null,
    },
    driver: {
      fullName: driver.fullName,
      cpf: ctx.pii.decrypt(driver.cpfEncrypted),
      cnhNumber: driver.cnh.number,
      cnhCategory: driver.cnh.category,
      cnhExpiresAt: driver.cnh.expiresAt,
      phone: driver.phone,
      address: address || null,
    },
    vehicle: { plate: vehicle.plate, brand: vehicle.brand, model: vehicle.model, year: vehicle.year, color: vehicle.color, renavam: vehicle.renavam },
    issuedAt: new Date(),
  };
}

export async function toSignatureDTO(ctx: AppContext, doc: ContractSignatureDoc): Promise<ContractSignature> {
  const files = doc.signedFileId ? await describeFiles(ctx, doc.organizationId, [doc.signedFileId]) : new Map();
  const f = doc.signedFileId ? files.get(doc.signedFileId.toHexString()) : undefined;
  return {
    id: doc._id.toHexString(),
    rentalId: doc.rentalId.toHexString(),
    status: doc.status,
    provider: doc.provider,
    signUrl: doc.status === 'SENT' ? doc.signUrl : null,
    identity: { selfie: doc.identity.selfie, document: doc.identity.document, validationType: doc.validationType },
    signedAt: doc.signedAt?.toISOString() ?? null,
    signedFile: f ? { fileId: f.id.toHexString(), url: f.url } : null,
    createdAt: doc.createdAt.toISOString(),
  };
}

export async function requestSignature(ctx: AppContext, rental: RentalDoc, actorId: ObjectId | null): Promise<ContractSignatureDoc> {
  const provider = ctx.integrations.signature;
  if (!provider.status().connected) throw integrationUnavailable(provider.status().message);
  if (rental.status === 'CANCELED') throw conflict('Locação cancelada.');
  const open = await ctx.mongo.collections.contractSignatures.findOne({ organizationId: rental.organizationId, rentalId: rental._id, status: { $in: ['SENT', 'SIGNED'] } });
  if (open?.status === 'SIGNED') throw conflict('O contrato desta locação já foi assinado.');
  if (open?.status === 'SENT') return open; // já enviado: reaproveita o link

  const data = await contractData(ctx, rental);
  const pdf = await renderRentalContract(data);
  let created;
  try {
    created = await provider.create({
      name: `Contrato ${rental.rentalNumber} - ${data.driver.fullName}`,
      base64Pdf: pdf.toString('base64'),
      externalId: rental._id.toHexString(),
      signer: {
        name: data.driver.fullName,
        email: (await ctx.mongo.collections.drivers.findOne({ _id: rental.driverId }))?.emailLower ?? null,
        phone: data.driver.phone,
        cpf: data.driver.cpf,
      },
      selfieValidation: ctx.env.ZAPSIGN_SELFIE_VALIDATION,
    });
  } catch (err) {
    throw integrationUnavailable((err as Error).message);
  }
  const now = new Date();
  const doc: ContractSignatureDoc = {
    _id: new ObjectId(),
    organizationId: rental.organizationId,
    rentalId: rental._id,
    driverId: rental.driverId,
    provider: 'ZAPSIGN',
    providerDocToken: created.docToken,
    signerToken: created.signerToken,
    signUrl: created.signUrl,
    status: 'SENT',
    validationType: created.validationType,
    identity: { selfie: true, document: true },
    signedAt: null,
    signedFileId: null,
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.mongo.collections.contractSignatures.insertOne(doc);
  await audit(ctx, { organizationId: rental.organizationId, actorId, action: 'contract.signatureRequested', entityType: 'rental', entityId: rental._id, after: { provider: 'ZAPSIGN', validation: created.validationType } });
  return doc;
}

/**
 * Sincroniza o estado com o provedor (fonte da verdade). Ao assinar:
 * baixa o PDF assinado, guarda como contrato da locação e avisa a equipe.
 */
export async function syncSignature(ctx: AppContext, doc: ContractSignatureDoc): Promise<ContractSignatureDoc> {
  if (doc.status !== 'SENT') return doc;
  const info = await ctx.integrations.signature.get(doc.providerDocToken);
  if (info.status === 'refused' || info.status === 'expired') {
    const status = info.status === 'refused' ? 'REFUSED' : 'EXPIRED';
    await ctx.mongo.collections.contractSignatures.updateOne({ _id: doc._id, status: 'SENT' }, { $set: { status, updatedAt: new Date() } });
    return { ...doc, status };
  }
  if (info.status !== 'signed') return doc;

  let fileId: ObjectId | null = null;
  if (info.signedFileUrl) {
    const buffer = await ctx.integrations.signature.download(info.signedFileUrl);
    const stored = await storeFile(ctx, {
      organizationId: doc.organizationId,
      uploadedBy: null,
      purpose: 'RENTAL_CONTRACT',
      originalName: `contrato-assinado-${doc.rentalId.toHexString()}.pdf`,
      declaredContentType: 'application/pdf',
      buffer,
    });
    fileId = stored.id;
  }
  const signedAt = info.signedAt ?? new Date();
  const res = await ctx.mongo.collections.contractSignatures.updateOne(
    { _id: doc._id, status: 'SENT' },
    { $set: { status: 'SIGNED', signedAt, signedFileId: fileId, identity: { selfie: info.selfie, document: info.document }, updatedAt: new Date() } },
  );
  if (res.modifiedCount === 0) return (await ctx.mongo.collections.contractSignatures.findOne({ _id: doc._id }))!;
  if (fileId) {
    await ctx.mongo.collections.rentals.updateOne({ _id: doc.rentalId }, { $set: { contractFileId: fileId, updatedAt: new Date() } });
  }
  const rental = await ctx.mongo.collections.rentals.findOne({ _id: doc.rentalId });
  await createNotification(ctx, {
    organizationId: doc.organizationId,
    type: 'RENTAL',
    severity: 'INFO',
    title: 'Contrato assinado',
    message: `O contrato ${rental?.rentalNumber ?? ''} foi assinado digitalmente pelo motorista (selfie e documento).`,
    subjectLabel: rental?.rentalNumber ?? null,
    entityType: 'rental',
    entityId: doc.rentalId,
    targetPath: `/dashboard/rentals/${doc.rentalId.toHexString()}`,
    dedupeKey: `contract-signed:${doc._id.toHexString()}`,
  });
  await audit(ctx, { organizationId: doc.organizationId, actorId: null, action: 'contract.signed', entityType: 'rental', entityId: doc.rentalId, after: { signedAt } });
  return (await ctx.mongo.collections.contractSignatures.findOne({ _id: doc._id }))!;
}

export async function cancelSignature(ctx: AppContext, rental: RentalDoc, actorId: ObjectId | null): Promise<void> {
  const res = await ctx.mongo.collections.contractSignatures.updateMany(
    { organizationId: rental.organizationId, rentalId: rental._id, status: 'SENT' },
    { $set: { status: 'CANCELED', updatedAt: new Date() } },
  );
  if (res.modifiedCount === 0) throw notFound('Não há assinatura pendente nesta locação.');
  await audit(ctx, { organizationId: rental.organizationId, actorId, action: 'contract.signatureCanceled', entityType: 'rental', entityId: rental._id });
}

/** Job: consulta as assinaturas pendentes (webhook perdido). */
export async function reconcileSignatures(ctx: AppContext, organizationId: ObjectId): Promise<number> {
  if (!ctx.integrations.signature.status().connected) return 0;
  const pending = await ctx.mongo.collections.contractSignatures.find({ organizationId, status: 'SENT' }).limit(100).toArray();
  let changed = 0;
  for (const doc of pending) {
    try {
      const next = await syncSignature(ctx, doc);
      if (next.status !== 'SENT') changed += 1;
    } catch {
      /* tenta de novo na próxima rodada */
    }
  }
  return changed;
}
