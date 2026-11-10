import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import {
  canPromoteMessage,
  DEFAULT_INSPECTION_WHATSAPP_SETTINGS,
  DEFAULT_PHOTO_SLOTS,
  ODOMETER_STEP_CODE,
  toE164BR,
  WHAPLY_CONTRACT_VERSION,
  whaplyEventDataSchemas,
  type CollectionStatus,
  type ErrorSource,
  type InspectionWhatsappSettings,
  type MessageKind,
  type MessageStatus,
  type WhaplyEventEnvelope,
  type WhaplyMessageRequest,
} from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import type {
  DriverDoc,
  InspectionCollection,
  InspectionDoc,
  OrganizationDoc,
  PhotoEvidence,
  PhotoSlotDoc,
  WhatsappMessageDoc,
  WhatsappMessageEvent,
} from '../database/types.js';
import { generateToken, sha256 } from '../common/helpers.js';
import { badRequest, conflict, notFound } from '../common/errors.js';
import { audit } from './common.js';
import { storeFile } from './files.js';
import { createNotification } from './notifications.js';
import { sha256Hex } from '../integrations/whaply/signing.js';

export class PermanentEventError extends Error {}

/* ------------------------------------------------------------------ *
 * Coleta de vistoria pelo WhatsApp via Whaply.
 * Plano: docs/architecture/yudirect-whaply-vistoria-plan.md
 *
 * Invariantes:
 *  - a vistoria NUNCA é aprovada/reprovada por evento externo;
 *  - cada mensagem lógica tem uma chave de idempotência única persistida
 *    (índice único) — jobs repetidos não duplicam envios;
 *  - retries automáticos reutilizam a mesma chave; reenvio manual usa
 *    chave nova e é auditado;
 *  - estados de mensagem só avançam (`canPromoteMessage`);
 *  - foto sem correlação confiável não é associada a vistoria.
 * ------------------------------------------------------------------ */

export const TIMEZONE = 'America/Sao_Paulo';
export const MAX_SEND_ATTEMPTS = 8;
const SUBMIT_LEASE_MS = 2 * 60 * 1000;
const RECONCILE_STALE_MS = 15 * 60 * 1000;
const SESSION_BUSY_DELAY_MS = 15 * 60 * 1000;
const PUBLIC_LINK_TTL_MS = 7 * 24 * 3600 * 1000;

/* ---------------------------- utilidades --------------------------- */

/** Deslocamento (ms) do fuso em relação ao UTC no instante dado. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - instant.getTime();
}

/**
 * Instante UTC correspondente a `date` (YYYY-MM-DD) às `time` (HH:mm) no
 * fuso informado. Duas iterações tornam o cálculo correto mesmo em
 * transições de horário de verão.
 */
export function localDateTimeToUtc(date: string, time: string, timeZone = TIMEZONE): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm, 0);
  let guess = wall - tzOffsetMs(new Date(wall), timeZone);
  guess = wall - tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

export function formatDateTimeLocal(instant: Date, timeZone = TIMEZONE): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant);
}

function formatDateBR(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/** Backoff exponencial com jitter (30 s × 2^n, teto 30 min). */
export function retryDelayMs(attempt: number, random = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 30 * 60_000);
  return Math.round(base * (0.8 + random() * 0.4));
}

export function messageIdempotencyKey(
  inspectionId: ObjectId,
  kind: Exclude<MessageKind, 'SESSION_PROMPT'>,
  round: number,
  seq: number,
): string {
  return `inspection:${inspectionId.toHexString()}:${kind}:r${round}:n${seq}`;
}

export function getWhatsappSettings(org: OrganizationDoc | null): InspectionWhatsappSettings {
  return { ...DEFAULT_INSPECTION_WHATSAPP_SETTINGS, ...(org?.settings?.inspectionWhatsapp ?? {}) };
}

export function hasValidConsent(driver: Pick<DriverDoc, 'whatsappConsent'> | null | undefined): boolean {
  return driver?.whatsappConsent?.status === 'GRANTED';
}

function versionFilter(doc: { version?: number }): Record<string, unknown> {
  return doc.version === undefined ? { version: { $exists: false } } : { version: doc.version };
}

function pushEvent(
  type: string,
  status: MessageStatus | null,
  source: WhatsappMessageEvent['source'],
  detail: string | null,
  eventId: string | null = null,
): WhatsappMessageEvent {
  return { at: new Date(), type, status, source, detail, eventId };
}

/* --------------------- elegibilidade e planejamento ---------------- */

export interface CollectionPlanInput {
  organization: OrganizationDoc | null;
  driver: DriverDoc | null;
  phone: string;
  scheduledAt: string;
  now?: Date;
}

export interface CollectionPlan {
  guided: boolean;
  status: CollectionStatus;
  reason: string | null;
  scheduledSendAt: Date | null;
}

/**
 * Decide se a vistoria será coletada pelo WhatsApp guiado.
 * Exige: integração Whaply ligada, configuração da organização ativa,
 * motorista vinculado com consentimento e o MESMO telefone do cadastro
 * (o consentimento cobre o número informado pelo motorista).
 */
export function planCollection(ctx: AppContext, input: CollectionPlanInput): CollectionPlan {
  const settings = getWhatsappSettings(input.organization);
  const channel = ctx.integrations.whaply.status();
  if (!channel.connected || !settings.enabled) {
    return { guided: false, status: 'NOT_SCHEDULED', reason: null, scheduledSendAt: null };
  }
  if (!input.driver) {
    return {
      guided: false,
      status: 'BLOCKED_NO_CONSENT',
      reason: 'Veículo sem motorista em locação ativa — consentimento não verificável.',
      scheduledSendAt: null,
    };
  }
  if (!hasValidConsent(input.driver)) {
    return {
      guided: false,
      status: 'BLOCKED_NO_CONSENT',
      reason: 'Motorista sem consentimento registrado para mensagens de vistoria pelo WhatsApp.',
      scheduledSendAt: null,
    };
  }
  const digits = (v: string) => v.replace(/\D+/g, '');
  if (digits(input.driver.phone) !== digits(input.phone)) {
    return {
      guided: false,
      status: 'BLOCKED_NO_CONSENT',
      reason: 'O telefone informado difere do cadastro do motorista; o consentimento não cobre este número.',
      scheduledSendAt: null,
    };
  }
  if (!toE164BR(input.phone)) {
    return { guided: false, status: 'FAILED', reason: 'Telefone inválido para WhatsApp.', scheduledSendAt: null };
  }
  const now = input.now ?? new Date();
  const at = localDateTimeToUtc(input.scheduledAt, settings.sendTime);
  return { guided: true, status: 'SCHEDULED', reason: null, scheduledSendAt: at < now ? now : at };
}

/** Cria (uma vez) os ângulos padrão da referência para a organização. */
export async function ensureDefaultSlots(ctx: AppContext, organizationId: ObjectId): Promise<PhotoSlotDoc[]> {
  const existing = await ctx.mongo.collections.inspectionPhotoSlots.find({ organizationId }).sort({ order: 1 }).toArray();
  if (existing.length > 0) return existing;
  const now = new Date();
  const docs: PhotoSlotDoc[] = DEFAULT_PHOTO_SLOTS.map((slot, index) => ({
    _id: new ObjectId(),
    organizationId,
    code: slot.code,
    label: slot.label,
    order: index,
    active: true,
    isDefault: true,
    createdAt: now,
    updatedAt: now,
  }));
  try {
    await ctx.mongo.collections.inspectionPhotoSlots.insertMany(docs, { ordered: false });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
  }
  return ctx.mongo.collections.inspectionPhotoSlots.find({ organizationId }).sort({ order: 1 }).toArray();
}

export async function requiredSlotsSnapshot(
  ctx: AppContext,
  organizationId: ObjectId,
  settings: InspectionWhatsappSettings,
): Promise<InspectionCollection['requiredSlots']> {
  const slots = (await ensureDefaultSlots(ctx, organizationId)).filter((s) => s.active);
  return slots.map((s, i) => ({
    code: s.code,
    label: s.label,
    order: i,
    instruction: s.instruction ?? settings.instructions[s.code] ?? null,
  }));
}

export function newCollection(
  plan: CollectionPlan,
  requiredSlots: InspectionCollection['requiredSlots'],
  round = 0,
): InspectionCollection {
  return {
    mode: plan.guided ? 'WHATSAPP' : 'WEB_LINK',
    status: plan.status,
    requiredSlots,
    requireOdometer: true,
    receivedSlots: [],
    round,
    correlationId: randomUUID(),
    sessionId: null,
    requestedAt: null,
    respondedAt: null,
    completedAt: null,
    remindersSent: 0,
    failureReason: plan.reason,
    updatedAt: new Date(),
  };
}

/* ------------------------- criação de intenção --------------------- */

function publicLink(ctx: AppContext, token: string): string {
  return `${ctx.env.APP_URL.replace(/\/$/, '')}/vistoria/${token}`;
}

/**
 * Garante um token de link público válido e devolve o valor bruto
 * (reaproveitado no botão de URL do template e no fallback manual).
 */
async function ensurePublicToken(ctx: AppContext, inspection: InspectionDoc, forceNew = false): Promise<string> {
  const existing = ctx.pii.decrypt(inspection.requestTokenEnc ?? null);
  const valid =
    existing &&
    inspection.requestTokenHash === sha256(existing) &&
    inspection.requestExpiresAt &&
    inspection.requestExpiresAt.getTime() > Date.now() + 24 * 3600 * 1000;
  if (valid && !forceNew) return existing;

  const token = generateToken(24);
  const expiresAt = new Date(Date.now() + PUBLIC_LINK_TTL_MS);
  await ctx.mongo.collections.inspections.updateOne(
    { _id: inspection._id },
    {
      $set: {
        requestTokenHash: sha256(token),
        requestTokenEnc: ctx.pii.encrypt(token),
        requestExpiresAt: expiresAt,
        updatedAt: new Date(),
      },
    },
  );
  inspection.requestTokenHash = sha256(token);
  inspection.requestTokenEnc = ctx.pii.encrypt(token);
  inspection.requestExpiresAt = expiresAt;
  return token;
}

export interface CreateIntentParams {
  inspection: InspectionDoc;
  kind: Exclude<MessageKind, 'SESSION_PROMPT'>;
  idempotencyKey: string;
  createdBy: ObjectId | null;
  manualOf?: ObjectId | null;
  correction?: { slots: Array<{ code: string; label: string }>; reason: string; requireOdometer: boolean };
}

/**
 * Cria a intenção de envio (outbox). Idempotente: se a chave já existir,
 * devolve a mensagem existente sem criar outra.
 */
export async function createMessageIntent(
  ctx: AppContext,
  params: CreateIntentParams,
): Promise<{ created: boolean; message: WhatsappMessageDoc }> {
  const c = ctx.mongo.collections;
  const existing = await c.whatsappMessages.findOne({
    organizationId: params.inspection.organizationId,
    idempotencyKey: params.idempotencyKey,
  });
  if (existing) return { created: false, message: existing };

  const inspection = params.inspection;
  const collection = inspection.collection;
  if (!collection) throw conflict('Vistoria sem plano de coleta pelo WhatsApp.');

  const [driver, vehicle, organization] = await Promise.all([
    inspection.driverId ? c.drivers.findOne({ _id: inspection.driverId, organizationId: inspection.organizationId }) : null,
    c.vehicles.findOne({ _id: inspection.vehicleId, organizationId: inspection.organizationId }),
    c.organizations.findOne({ _id: inspection.organizationId }),
  ]);
  if (!driver || !hasValidConsent(driver)) throw conflict('Motorista sem consentimento para WhatsApp.');
  const phoneE164 = toE164BR(inspection.phone);
  if (!phoneE164) throw badRequest('Telefone inválido para WhatsApp.');

  const settings = getWhatsappSettings(organization);
  const token = await ensurePublicToken(ctx, inspection);
  const firstName = inspection.responsibleName.split(/\s+/)[0] ?? inspection.responsibleName;
  const plate = vehicle?.plate ?? '—';
  const expiresAt = new Date(Date.now() + settings.collectionTtlHours * 3600 * 1000);
  const deadline = formatDateTimeLocal(expiresAt);

  let templateName: string;
  let bodyParams: string[];
  let session: WhaplyMessageRequest['session'] = null;

  if (params.kind === 'INSPECTION_REQUEST') {
    templateName = ctx.env.WHAPLY_TEMPLATE_REQUEST;
    const photoCount = collection.requiredSlots.length;
    bodyParams = [firstName, plate, formatDateBR(inspection.scheduledAt), String(photoCount), deadline];
    session = {
      round: collection.round,
      expiresAt: expiresAt.toISOString(),
      steps: [
        ...collection.requiredSlots.map((s) => ({
          code: s.code,
          label: s.label,
          instruction: s.instruction,
          type: 'IMAGE' as const,
        })),
        ...(collection.requireOdometer
          ? [{ code: ODOMETER_STEP_CODE, label: 'Quilometragem', instruction: 'Digite a quilometragem atual do painel, apenas números.', type: 'NUMBER' as const }]
          : []),
      ],
    };
  } else if (params.kind === 'REMINDER') {
    templateName = ctx.env.WHAPLY_TEMPLATE_REMINDER;
    const ttlEnd = collection.requestedAt
      ? new Date(collection.requestedAt.getTime() + settings.collectionTtlHours * 3600 * 1000)
      : expiresAt;
    bodyParams = [firstName, plate, formatDateTimeLocal(ttlEnd)];
  } else {
    if (!params.correction) throw badRequest('Correção sem ângulos informados.');
    templateName = ctx.env.WHAPLY_TEMPLATE_CORRECTION;
    bodyParams = [
      firstName,
      plate,
      params.correction.slots.map((s) => s.label).join(', '),
      params.correction.reason,
    ];
    session = {
      round: collection.round,
      expiresAt: expiresAt.toISOString(),
      steps: [
        ...params.correction.slots
          .filter((s) => s.code !== ODOMETER_STEP_CODE)
          .map((s) => {
            const slot = collection.requiredSlots.find((r) => r.code === s.code);
            return { code: s.code, label: s.label, instruction: slot?.instruction ?? null, type: 'IMAGE' as const };
          }),
        ...(params.correction.requireOdometer
          ? [{ code: ODOMETER_STEP_CODE, label: 'Quilometragem', instruction: 'Digite a quilometragem atual do painel, apenas números.', type: 'NUMBER' as const }]
          : []),
      ],
    };
  }

  const request: WhaplyMessageRequest = {
    contractVersion: WHAPLY_CONTRACT_VERSION,
    idempotencyKey: params.idempotencyKey,
    correlationId: collection.correlationId,
    externalRef: { type: 'inspection', id: inspection._id.toHexString() },
    kind: params.kind,
    recipient: { phoneE164, name: inspection.responsibleName.slice(0, 120) },
    consent: {
      grantedAt: (driver.whatsappConsent!.grantedAt ?? new Date()).toISOString(),
      source: driver.whatsappConsent!.source ?? 'OTHER',
    },
    template: {
      name: templateName,
      language: ctx.env.WHAPLY_TEMPLATE_LANGUAGE,
      bodyParams,
      urlButtonParam: token,
    },
    session,
  };
  const body = JSON.stringify(request);
  const now = new Date();
  const doc: WhatsappMessageDoc = {
    _id: new ObjectId(),
    organizationId: inspection.organizationId,
    inspectionId: inspection._id,
    driverId: inspection.driverId,
    kind: params.kind,
    idempotencyKey: params.idempotencyKey,
    correlationId: collection.correlationId,
    templateName,
    category: 'UTILITY',
    status: 'INTENT_CREATED',
    requestPayloadEnc: ctx.pii.encrypt(body),
    requestHash: sha256Hex(body),
    whaplyRequestId: null,
    sessionId: null,
    wamid: null,
    attempts: 0,
    nextAttemptAt: now,
    leaseUntil: null,
    lastError: null,
    pricing: null,
    timestamps: {
      intentAt: now,
      submittedAt: null,
      acceptedAt: null,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
    },
    recipientName: inspection.responsibleName,
    recipientPhone: inspection.phone,
    createdBy: params.createdBy,
    manualOf: params.manualOf ?? null,
    events: [pushEvent('intent.created', 'INTENT_CREATED', 'YUDIRECT', params.manualOf ? 'Reenvio manual' : null)],
    createdAt: now,
    updatedAt: now,
  };
  try {
    await c.whatsappMessages.insertOne(doc);
    return { created: true, message: doc };
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const dup = await c.whatsappMessages.findOne({
        organizationId: inspection.organizationId,
        idempotencyKey: params.idempotencyKey,
      });
      if (dup) return { created: false, message: dup };
    }
    throw err;
  }
}

/* ------------------------------ disparo ---------------------------- */

/**
 * Vistorias com coleta agendada cuja hora chegou → intenção única.
 * O "claim" (SCHEDULED → REQUESTED) é condicional; a intenção usa chave
 * determinística — dois workers simultâneos geram UMA mensagem.
 */
export async function dispatchDueInspections(ctx: AppContext, now = new Date()): Promise<number> {
  const c = ctx.mongo.collections;
  const due = await c.inspections
    .find({
      status: 'PENDING',
      'collection.mode': 'WHATSAPP',
      'collection.status': 'SCHEDULED',
      scheduledSendAt: { $lte: now },
    })
    .limit(100)
    .toArray();

  let created = 0;
  for (const inspection of due) {
    const driver = inspection.driverId
      ? await c.drivers.findOne({ _id: inspection.driverId, organizationId: inspection.organizationId })
      : null;
    if (!hasValidConsent(driver)) {
      await c.inspections.updateOne(
        { _id: inspection._id, 'collection.status': 'SCHEDULED' },
        {
          $set: {
            'collection.status': 'BLOCKED_NO_CONSENT',
            'collection.failureReason': 'Consentimento ausente ou revogado no momento do disparo.',
            'collection.updatedAt': now,
            updatedAt: now,
          },
        },
      );
      await createNotification(ctx, {
        organizationId: inspection.organizationId,
        type: 'INSPECTION',
        severity: 'WARNING',
        title: 'Vistoria não enviada pelo WhatsApp',
        message: `${inspection.responsibleName}: sem consentimento para mensagens de vistoria. Use o link manual.`,
        entityType: 'inspection',
        entityId: inspection._id,
        targetPath: `/dashboard/inspections/${inspection.vehicleId.toHexString()}`,
        dedupeKey: `wa-no-consent:${inspection._id.toHexString()}`,
      });
      continue;
    }

    const claim = await c.inspections.findOneAndUpdate(
      { _id: inspection._id, status: 'PENDING', 'collection.status': 'SCHEDULED' },
      {
        $set: {
          'collection.status': 'REQUESTED',
          'collection.requestedAt': now,
          'collection.updatedAt': now,
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after' },
    );
    if (!claim) continue;
    const result = await createMessageIntent(ctx, {
      inspection: claim,
      kind: 'INSPECTION_REQUEST',
      idempotencyKey: messageIdempotencyKey(claim._id, 'INSPECTION_REQUEST', claim.collection!.round, 0),
      createdBy: null,
    });
    if (result.created) created += 1;
  }

  // Recuperação: vistoria marcada REQUESTED sem intenção (processo caiu
  // entre o claim e o insert). A chave determinística evita duplicata.
  const orphans = await c.inspections
    .find({
      status: 'PENDING',
      'collection.mode': 'WHATSAPP',
      'collection.status': 'REQUESTED',
      'collection.round': 0,
      'collection.requestedAt': { $lte: new Date(now.getTime() - 60_000) },
    })
    .limit(100)
    .toArray();
  for (const inspection of orphans) {
    const key = messageIdempotencyKey(inspection._id, 'INSPECTION_REQUEST', 0, 0);
    const exists = await c.whatsappMessages.countDocuments({ organizationId: inspection.organizationId, idempotencyKey: key });
    if (exists === 0) {
      const r = await createMessageIntent(ctx, { inspection, kind: 'INSPECTION_REQUEST', idempotencyKey: key, createdBy: null });
      if (r.created) created += 1;
    }
  }
  return created;
}

/* ------------------------------ outbox ----------------------------- */

async function promoteMessage(
  ctx: AppContext,
  message: WhatsappMessageDoc,
  to: MessageStatus,
  extra: {
    set?: Record<string, unknown>;
    event: WhatsappMessageEvent;
    error?: { code: string; message: string; source: ErrorSource } | null;
  },
): Promise<WhatsappMessageDoc | null> {
  if (!canPromoteMessage(message.status, to)) {
    // Registra o evento mesmo sem mudança de estado (rastreabilidade).
    await ctx.mongo.collections.whatsappMessages.updateOne(
      { _id: message._id },
      { $push: { events: { $each: [extra.event], $slice: -200 } }, $set: { updatedAt: new Date(), ...(extra.set ?? {}) } },
    );
    return null;
  }
  const now = new Date();
  const ts: Record<string, Date> = {};
  if (to === 'ACCEPTED_BY_WHAPLY' || to === 'ACCEPTED_BY_META') ts['timestamps.acceptedAt'] = now;
  if (to === 'SENT') ts['timestamps.sentAt'] = now;
  if (to === 'DELIVERED') ts['timestamps.deliveredAt'] = now;
  if (to === 'READ') {
    ts['timestamps.readAt'] = now;
    if (!message.timestamps.deliveredAt) ts['timestamps.deliveredAt'] = now;
  }
  if (to === 'FAILED') ts['timestamps.failedAt'] = now;
  const res = await ctx.mongo.collections.whatsappMessages.findOneAndUpdate(
    { _id: message._id, status: message.status },
    {
      $set: {
        status: to,
        updatedAt: now,
        ...ts,
        ...(extra.error ? { lastError: { ...extra.error, at: now } } : {}),
        ...(extra.set ?? {}),
      },
      $push: { events: { $each: [extra.event], $slice: -200 } },
    },
    { returnDocument: 'after' },
  );
  return res;
}

async function onDefinitiveFailure(
  ctx: AppContext,
  message: WhatsappMessageDoc,
  error: { code: string; message: string; source: ErrorSource },
): Promise<void> {
  if (!message.inspectionId) return;
  const c = ctx.mongo.collections;
  const inspection = await c.inspections.findOne({ _id: message.inspectionId });
  if (!inspection) return;

  if (error.code === 'OPTED_OUT') {
    await revokeConsentFromChannel(ctx, inspection, 'Cliente optou por não receber mensagens (Whaply).');
  }

  if (message.kind !== 'REMINDER' && inspection.status === 'PENDING') {
    const token = ctx.pii.decrypt(inspection.requestTokenEnc ?? null);
    await c.inspections.updateOne(
      { _id: inspection._id },
      {
        $set: {
          'collection.status': 'FAILED',
          'collection.failureReason': `${error.message} (${error.code})`,
          'collection.updatedAt': new Date(),
          delivery: {
            channel: 'MANUAL',
            status: 'FAILED',
            message: error.message,
            manualLink: token ? publicLink(ctx, token) : null,
            attempts: message.attempts,
          },
          updatedAt: new Date(),
        },
        $inc: { version: 1 },
      },
    );
  }
  await createNotification(ctx, {
    organizationId: message.organizationId,
    type: 'INSPECTION',
    severity: 'CRITICAL',
    title: 'Falha no envio da vistoria pelo WhatsApp',
    message: `${message.recipientName ?? 'Cliente'}: ${error.message}. Envie o link manualmente.`,
    entityType: 'inspection',
    entityId: message.inspectionId,
    targetPath: `/dashboard/messages?message=${message._id.toHexString()}`,
    dedupeKey: `wa-failed:${message._id.toHexString()}`,
  });
}

/**
 * Envia as intenções pendentes ao Whaply. Claim atômico por mensagem;
 * retries reutilizam o MESMO corpo e a MESMA chave de idempotência.
 */
export async function sendPendingMessages(ctx: AppContext, now = new Date()): Promise<number> {
  const c = ctx.mongo.collections;
  let sent = 0;
  const seen: ObjectId[] = [];
  for (let i = 0; i < 50; i += 1) {
    const claimed = await c.whatsappMessages.findOneAndUpdate(
      {
        _id: { $nin: seen }, // no máximo uma tentativa por mensagem por execução
        status: { $in: ['INTENT_CREATED', 'RETRY_SCHEDULED'] },
        nextAttemptAt: { $lte: now },
        $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
      },
      {
        $set: {
          status: 'SUBMITTED_TO_WHAPLY',
          leaseUntil: new Date(now.getTime() + SUBMIT_LEASE_MS),
          'timestamps.submittedAt': now,
          updatedAt: now,
        },
        $inc: { attempts: 1 },
        $push: { events: { $each: [pushEvent('submit.attempt', 'SUBMITTED_TO_WHAPLY', 'YUDIRECT', null)], $slice: -200 } },
      },
      { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
    );
    if (!claimed) break;
    seen.push(claimed._id);
    await submitClaimed(ctx, claimed, now);
    sent += 1;
  }
  return sent;
}

async function submitClaimed(ctx: AppContext, message: WhatsappMessageDoc, now: Date): Promise<void> {
  const c = ctx.mongo.collections;
  const body = ctx.pii.decrypt(message.requestPayloadEnc);
  if (!body) {
    await promoteMessage(ctx, message, 'FAILED', {
      event: pushEvent('submit.failed', 'FAILED', 'YUDIRECT', 'Corpo da requisição ilegível (segredo alterado?)'),
      error: { code: 'PAYLOAD_UNREADABLE', message: 'Corpo da requisição ilegível.', source: 'YUDIRECT' },
    });
    return;
  }

  // Vistoria cancelada antes do envio: não envia.
  if (message.inspectionId) {
    const inspection = await c.inspections.findOne({ _id: message.inspectionId });
    if (!inspection || inspection.status === 'CANCELED' || inspection.collection?.status === 'CANCELED') {
      await c.whatsappMessages.updateOne(
        { _id: message._id },
        {
          $set: { status: 'CANCELED', leaseUntil: null, updatedAt: new Date() },
          $push: { events: { $each: [pushEvent('canceled', 'CANCELED', 'YUDIRECT', 'Vistoria cancelada antes do envio')], $slice: -200 } },
        },
      );
      return;
    }
  }

  const result = await ctx.integrations.whaply.sendMessage(body, message.idempotencyKey);
  if (result.ok) {
    const state = result.data.state;
    const target: MessageStatus =
      state === 'ACCEPTED_BY_WHAPLY' || state === 'DEFERRED'
        ? 'ACCEPTED_BY_WHAPLY'
        : state === 'FAILED'
          ? 'FAILED'
          : (state as MessageStatus);
    const updated = await promoteMessage(ctx, message, target, {
      set: {
        whaplyRequestId: result.data.requestId,
        sessionId: result.data.sessionId ?? null,
        leaseUntil: null,
        nextAttemptAt: null,
        ...(result.data.wamid ? { wamid: result.data.wamid } : {}),
      },
      event: pushEvent('submit.accepted', target, 'WHAPLY', `HTTP ${result.status} · ${state}`),
    });
    // Eventos podem ter chegado antes desta resposta — garante os campos.
    if (!updated) {
      await c.whatsappMessages.updateOne(
        { _id: message._id, whaplyRequestId: null },
        { $set: { whaplyRequestId: result.data.requestId, leaseUntil: null, nextAttemptAt: null } },
      );
    }
    if (message.inspectionId && result.data.sessionId) {
      await c.inspections.updateOne(
        { _id: message.inspectionId },
        { $set: { 'collection.sessionId': result.data.sessionId, updatedAt: now } },
      );
    }
    return;
  }

  const error = { code: result.code, message: result.message, source: result.source as ErrorSource };
  if (result.retryable && message.attempts < MAX_SEND_ATTEMPTS) {
    const delay = result.retryAfterSeconds ? result.retryAfterSeconds * 1000 : retryDelayMs(message.attempts);
    await promoteMessage(ctx, message, 'RETRY_SCHEDULED', {
      set: { leaseUntil: null, nextAttemptAt: new Date(now.getTime() + delay) },
      event: pushEvent('submit.retry', 'RETRY_SCHEDULED', error.source, `${error.code}: ${error.message}`),
      error,
    });
    return;
  }
  if (result.code === 'SESSION_BUSY') {
    // Contato em outra coleta ativa: aguarda sem consumir o limite.
    await promoteMessage(ctx, message, 'RETRY_SCHEDULED', {
      set: { leaseUntil: null, nextAttemptAt: new Date(now.getTime() + SESSION_BUSY_DELAY_MS), attempts: Math.max(0, message.attempts - 1) },
      event: pushEvent('submit.session_busy', 'RETRY_SCHEDULED', 'WHAPLY', 'Contato com outra coleta em andamento'),
      error,
    });
    return;
  }
  const failed = await promoteMessage(ctx, message, 'FAILED', {
    set: { leaseUntil: null, nextAttemptAt: null },
    event: pushEvent('submit.failed', 'FAILED', error.source, `${error.code}: ${error.message}`),
    error,
  });
  if (failed) await onDefinitiveFailure(ctx, failed, error);
}

/* --------------------------- reconciliação ------------------------- */

const STATUS_FROM_WHAPLY: Record<string, MessageStatus> = {
  ACCEPTED_BY_WHAPLY: 'ACCEPTED_BY_WHAPLY',
  DEFERRED: 'ACCEPTED_BY_WHAPLY',
  ACCEPTED_BY_META: 'ACCEPTED_BY_META',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED',
  CANCELED: 'CANCELED',
};

export async function reconcileMessages(ctx: AppContext, now = new Date()): Promise<{ recovered: number; polled: number; replayed: number }> {
  const c = ctx.mongo.collections;
  let recovered = 0;
  let polled = 0;

  // 1) Envio interrompido (processo caiu durante o POST): volta para a
  //    fila com a mesma chave — o Whaply deduplica.
  const stuck = await c.whatsappMessages.updateMany(
    { status: 'SUBMITTED_TO_WHAPLY', leaseUntil: { $lte: now } },
    {
      $set: { status: 'RETRY_SCHEDULED', nextAttemptAt: now, leaseUntil: null, updatedAt: now },
      $push: { events: { $each: [pushEvent('reconcile.requeued', 'RETRY_SCHEDULED', 'SYSTEM', 'Envio interrompido — reenfileirado com a mesma chave')], $slice: -200 } },
    },
  );
  recovered += stuck.modifiedCount;

  // 2) Aceitas sem evento recente: consulta o estado real no Whaply.
  const stale = await c.whatsappMessages
    .find({
      status: { $in: ['ACCEPTED_BY_WHAPLY', 'ACCEPTED_BY_META', 'SENT'] },
      whaplyRequestId: { $type: 'string' },
      updatedAt: { $lte: new Date(now.getTime() - RECONCILE_STALE_MS) },
    })
    .limit(50)
    .toArray();
  for (const message of stale) {
    const res = await ctx.integrations.whaply.getMessage(message.whaplyRequestId!);
    polled += 1;
    if (!res.ok) continue;
    const target = STATUS_FROM_WHAPLY[res.data.state];
    if (target) {
      const updated = await promoteMessage(ctx, message, target, {
        set: res.data.wamid ? { wamid: res.data.wamid } : {},
        event: pushEvent('reconcile.poll', target, 'WHAPLY', `Estado consultado: ${res.data.state}`),
      });
      if (updated && target === 'FAILED') {
        await onDefinitiveFailure(ctx, updated, { code: 'META_FAILED', message: 'Falha informada na reconciliação', source: 'META' });
      }
    } else {
      await c.whatsappMessages.updateOne({ _id: message._id }, { $set: { updatedAt: now } });
    }
  }

  // 3) Eventos não recebidos (callback perdido): replay por sequência.
  const replayed = await replayMissedEvents(ctx);
  // 4) Eventos recebidos mas não processados (falha transitória).
  await retryUnprocessedInbox(ctx, now);
  return { recovered, polled, replayed };
}

async function replayMissedEvents(ctx: AppContext): Promise<number> {
  if (!ctx.integrations.whaply.status().connected) return 0;
  const cursor = await ctx.mongo.collections.integrationCursors.findOne({ _id: 'whaply' });
  const res = await ctx.integrations.whaply.getEvents(cursor?.lastSeq ?? 0, 100);
  if (!res.ok) return 0;
  let processed = 0;
  for (const raw of res.data.data ?? []) {
    try {
      const outcome = await ingestWhaplyEvent(ctx, raw);
      if (outcome !== 'duplicate') processed += 1;
    } catch {
      /* fica no inbox para nova tentativa */
    }
  }
  return processed;
}

async function retryUnprocessedInbox(ctx: AppContext, now: Date): Promise<void> {
  const pending = await ctx.mongo.collections.integrationInbox
    .find({ processedAt: null, receivedAt: { $lte: new Date(now.getTime() - 60_000) }, attempts: { $lt: 20 } })
    .sort({ seq: 1 })
    .limit(50)
    .toArray();
  for (const item of pending) {
    try {
      await processEvent(ctx, item.payload as WhaplyEventEnvelope);
      await ctx.mongo.collections.integrationInbox.updateOne({ _id: item._id }, { $set: { processedAt: new Date(), lastError: null } });
    } catch (err) {
      await ctx.mongo.collections.integrationInbox.updateOne(
        { _id: item._id },
        { $inc: { attempts: 1 }, $set: { lastError: (err as Error).message.slice(0, 500) } },
      );
    }
  }
  await advanceCursor(ctx);
}

async function advanceCursor(ctx: AppContext): Promise<void> {
  const c = ctx.mongo.collections;
  const cursor = await c.integrationCursors.findOne({ _id: 'whaply' });
  let last = cursor?.lastSeq ?? 0;
  for (let i = 0; i < 1000; i += 1) {
    const next = await c.integrationInbox.findOne({ seq: last + 1, processedAt: { $ne: null } });
    if (!next) break;
    last += 1;
  }
  if (last !== (cursor?.lastSeq ?? 0)) {
    await c.integrationCursors.updateOne(
      { _id: 'whaply' },
      { $max: { lastSeq: last }, $set: { updatedAt: new Date() } },
      { upsert: true },
    );
  }
}

/* --------------------------- eventos (inbox) ----------------------- */

export type IngestOutcome = 'processed' | 'duplicate' | 'ignored';

/**
 * Registra e processa um evento do Whaply de forma idempotente.
 * Lança erro quando o processamento falha de forma transitória — o
 * chamador responde 5xx e o Whaply reenviará o mesmo `eventId`.
 */
export async function ingestWhaplyEvent(ctx: AppContext, envelope: WhaplyEventEnvelope): Promise<IngestOutcome> {
  const c = ctx.mongo.collections;
  const now = new Date();
  try {
    await c.integrationInbox.insertOne({
      _id: envelope.eventId,
      organizationId: null,
      type: envelope.type,
      seq: envelope.seq,
      receivedAt: now,
      processedAt: null,
      attempts: 0,
      lastError: null,
      payload: envelope,
    });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    const existing = await c.integrationInbox.findOne({ _id: envelope.eventId });
    if (existing?.processedAt) return 'duplicate';
  }

  try {
    const outcome = await processEvent(ctx, envelope);
    await c.integrationInbox.updateOne(
      { _id: envelope.eventId },
      { $set: { processedAt: new Date(), lastError: null }, $inc: { attempts: 1 } },
    );
    await advanceCursor(ctx);
    return outcome;
  } catch (err) {
    const permanent = err instanceof PermanentEventError;
    await c.integrationInbox.updateOne(
      { _id: envelope.eventId },
      {
        $inc: { attempts: 1 },
        // Erro permanente (payload inválido): reconhece para não virar
        // "veneno" no reenvio, mas guarda o motivo para auditoria.
        $set: { lastError: (err as Error).message.slice(0, 500), ...(permanent ? { processedAt: new Date() } : {}) },
      },
    );
    if (permanent) {
      await advanceCursor(ctx);
      return 'ignored';
    }
    throw err;
  }
}

async function findMessageForEvent(
  ctx: AppContext,
  envelope: WhaplyEventEnvelope,
  data: { idempotencyKey?: string | null; wamid?: string | null },
): Promise<WhatsappMessageDoc | null> {
  const c = ctx.mongo.collections;
  if (data.idempotencyKey) {
    const byKey = await c.whatsappMessages.findOne({ idempotencyKey: data.idempotencyKey });
    if (byKey) return byKey;
  }
  if (envelope.requestId) {
    const byReq = await c.whatsappMessages.findOne({ whaplyRequestId: envelope.requestId });
    if (byReq) return byReq;
  }
  if (data.wamid) return c.whatsappMessages.findOne({ wamid: data.wamid });
  return null;
}

async function loadInspectionForEvent(ctx: AppContext, envelope: WhaplyEventEnvelope): Promise<InspectionDoc | null> {
  const ref = envelope.externalRef;
  if (!ref || ref.type !== 'inspection' || !ObjectId.isValid(ref.id)) return null;
  return ctx.mongo.collections.inspections.findOne({ _id: new ObjectId(ref.id) });
}

const MESSAGE_EVENT_STATUS: Record<string, MessageStatus> = {
  'message.accepted': 'ACCEPTED_BY_META',
  'message.deferred': 'DEFERRED',
  'message.sent': 'SENT',
  'message.delivered': 'DELIVERED',
  'message.read': 'READ',
  'message.failed': 'FAILED',
};

async function processEvent(ctx: AppContext, envelope: WhaplyEventEnvelope): Promise<IngestOutcome> {
  const schema = whaplyEventDataSchemas[envelope.type as keyof typeof whaplyEventDataSchemas];
  if (!schema) {
    // Tipo desconhecido (versão mais nova do Whaply): registrado e ignorado.
    return 'ignored';
  }
  const parsed = schema.safeParse(envelope.data);
  if (!parsed.success) throw new PermanentEventError(`Dados inválidos para ${envelope.type}`);

  if (envelope.type.startsWith('message.')) {
    return handleMessageEvent(ctx, envelope, parsed.data as z_MessageData);
  }
  switch (envelope.type) {
    case 'session.started':
      return handleSessionStarted(ctx, envelope);
    case 'session.media_received':
      return handleMediaReceived(ctx, envelope, parsed.data as z_MediaData);
    case 'session.text_received':
      return handleTextReceived(ctx, envelope, parsed.data as { slotCode: string; value: string });
    case 'session.completed':
      return handleSessionCompleted(ctx, envelope);
    case 'session.expired':
      return handleSessionExpired(ctx, envelope);
    case 'session.opted_out':
      return handleOptOut(ctx, envelope);
    case 'media.unmatched':
      return handleUnmatchedMedia(ctx, envelope, parsed.data as z_MediaData & { reason: string });
    case 'template.status_changed':
      return handleTemplateStatus(ctx, envelope, parsed.data as { name: string; status: string; category?: string | null; reason?: string | null });
    default:
      return 'ignored';
  }
}

type z_MessageData = {
  idempotencyKey?: string | null;
  wamid?: string | null;
  kind?: MessageKind;
  pricing?: { billable?: boolean | null; category?: string | null; type?: string | null } | null;
  code?: string | number | null;
  title?: string | null;
  permanent?: boolean;
  source?: 'WHAPLY' | 'META';
  reason?: string | null;
};

type z_MediaData = {
  slotCode: string | null;
  mediaRef: string;
  sha256: string;
  mimeType: string;
  size: number;
  wamid: string;
  contextWamid?: string | null;
  round?: number;
};

async function handleMessageEvent(ctx: AppContext, envelope: WhaplyEventEnvelope, data: z_MessageData): Promise<IngestOutcome> {
  const c = ctx.mongo.collections;
  const target = MESSAGE_EVENT_STATUS[envelope.type]!;
  let message = await findMessageForEvent(ctx, envelope, data);

  // Instruções da coleta guiada (mensagens livres na janela): o YuDirect
  // só conhece por evento — registradas para custos e rastreabilidade.
  if (!message && data.kind === 'SESSION_PROMPT' && data.wamid) {
    const inspection = await loadInspectionForEvent(ctx, envelope);
    if (!inspection) return 'ignored';
    const now = new Date();
    try {
      await c.whatsappMessages.insertOne({
        _id: new ObjectId(),
        organizationId: inspection.organizationId,
        inspectionId: inspection._id,
        driverId: inspection.driverId,
        kind: 'SESSION_PROMPT',
        idempotencyKey: `session-prompt:${data.wamid}`,
        correlationId: envelope.correlationId ?? inspection.collection?.correlationId ?? '',
        templateName: null,
        category: 'SERVICE',
        status: 'ACCEPTED_BY_META',
        requestPayloadEnc: null,
        requestHash: null,
        whaplyRequestId: null,
        sessionId: envelope.sessionId ?? null,
        wamid: data.wamid,
        attempts: 1,
        nextAttemptAt: null,
        leaseUntil: null,
        lastError: null,
        pricing: null,
        timestamps: { intentAt: now, submittedAt: now, acceptedAt: now, sentAt: null, deliveredAt: null, readAt: null, failedAt: null },
        recipientName: inspection.responsibleName,
        recipientPhone: inspection.phone,
        createdBy: null,
        manualOf: null,
        events: [pushEvent(envelope.type, 'ACCEPTED_BY_META', 'WHAPLY', 'Instrução da coleta guiada', envelope.eventId)],
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
    message = await c.whatsappMessages.findOne({ wamid: data.wamid });
    if (!message) return 'ignored';
  }
  if (!message) {
    // Sem vistoria correspondente: evento que não pertence a este sistema
    // (ou referência inválida) — reconhecido e descartado para não travar
    // o cursor de reconciliação.
    if (!(await loadInspectionForEvent(ctx, envelope))) {
      throw new PermanentEventError(`Evento ${envelope.type} sem mensagem nem vistoria correspondente`);
    }
    // Vistoria existe mas a mensagem ainda não: falha transitória (replay).
    throw new Error(`Mensagem não encontrada para ${envelope.type} (${envelope.requestId ?? data.wamid ?? 'sem id'})`);
  }

  const set: Record<string, unknown> = {};
  if (data.wamid && !message.wamid) set.wamid = data.wamid;
  if (envelope.requestId && !message.whaplyRequestId) set.whaplyRequestId = envelope.requestId;
  if (data.pricing) {
    set.pricing = {
      billable: data.pricing.billable ?? null,
      category: data.pricing.category ? String(data.pricing.category).toUpperCase() : null,
      type: data.pricing.type ?? null,
    };
  }
  const isFailure = target === 'FAILED';
  const errorSource: ErrorSource = data.source === 'WHAPLY' ? 'WHAPLY' : 'META';
  const error = isFailure
    ? { code: String(data.code ?? 'UNKNOWN'), message: data.title ?? 'Falha informada pelo canal', source: errorSource }
    : null;

  // DEFERRED é informativo depois de aceito: não regride.
  const effective: MessageStatus =
    target === 'DEFERRED' && message.status !== 'SUBMITTED_TO_WHAPLY' && message.status !== 'ACCEPTED_BY_WHAPLY'
      ? message.status
      : target;
  const updated = await promoteMessage(ctx, message, effective, {
    set,
    event: pushEvent(envelope.type, target, isFailure ? errorSource : 'WHAPLY', error ? `${error.code}: ${error.message}` : data.reason ?? null, envelope.eventId),
    error,
  });

  if (updated && message.inspectionId && message.kind !== 'SESSION_PROMPT') {
    if (target === 'SENT' || target === 'DELIVERED' || target === 'READ') {
      await c.inspections.updateOne(
        { _id: message.inspectionId, status: 'PENDING' },
        {
          $set: {
            delivery: { channel: 'WHATSAPP', status: 'SENT', message: null, manualLink: null, attempts: message.attempts },
            updatedAt: new Date(),
          },
        },
      );
    }
    if (isFailure && (data.permanent ?? true)) await onDefinitiveFailure(ctx, updated, error!);
  }
  return 'processed';
}

async function handleSessionStarted(ctx: AppContext, envelope: WhaplyEventEnvelope): Promise<IngestOutcome> {
  const inspection = await loadInspectionForEvent(ctx, envelope);
  if (!inspection?.collection) return 'ignored';
  const now = new Date();
  await ctx.mongo.collections.inspections.updateOne(
    { _id: inspection._id, status: 'PENDING', 'collection.status': { $in: ['REQUESTED', 'SCHEDULED'] } },
    {
      $set: {
        'collection.status': 'IN_PROGRESS',
        'collection.respondedAt': inspection.collection.respondedAt ?? now,
        'collection.updatedAt': now,
        ...(envelope.sessionId ? { 'collection.sessionId': envelope.sessionId } : {}),
        updatedAt: now,
      },
      $inc: { version: 1 },
    },
  );
  return 'processed';
}

/** Recalcula a visão atual (`photos`) a partir das evidências vigentes. */
export function currentPhotos(evidence: PhotoEvidence[]): InspectionDoc['photos'] {
  const bySlot = new Map<string, PhotoEvidence>();
  for (const e of evidence) {
    if (!e.slotCode || e.supersededAt || e.late) continue;
    const prev = bySlot.get(e.slotCode);
    if (!prev || prev.receivedAt <= e.receivedAt) bySlot.set(e.slotCode, e);
  }
  return [...bySlot.values()].map((e) => ({ slotCode: e.slotCode!, slotLabel: e.slotLabel, fileId: e.fileId }));
}

async function updateWithEvidence(
  ctx: AppContext,
  inspectionId: ObjectId,
  mutate: (doc: InspectionDoc) => { set: Record<string, unknown> } | null,
): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const doc = await ctx.mongo.collections.inspections.findOne({ _id: inspectionId });
    if (!doc) return false;
    const change = mutate(doc);
    if (!change) return false;
    const res = await ctx.mongo.collections.inspections.updateOne(
      { _id: inspectionId, ...versionFilter(doc) },
      { $set: { ...change.set, version: (doc.version ?? 0) + 1, updatedAt: new Date() } },
    );
    if (res.modifiedCount === 1) return true;
  }
  throw new Error('Conflito de concorrência ao registrar evidência — será reprocessado.');
}

async function handleMediaReceived(ctx: AppContext, envelope: WhaplyEventEnvelope, data: z_MediaData): Promise<IngestOutcome> {
  const inspection = await loadInspectionForEvent(ctx, envelope);
  if (!inspection) return 'ignored';
  if ((inspection.photoEvidence ?? []).some((e) => e.wamid === data.wamid)) return 'processed';

  const media = await ctx.integrations.whaply.fetchMedia(data.mediaRef);
  if (!media.ok) {
    if (media.retryable) throw new Error(`Mídia indisponível no momento: ${media.message}`);
    await mediaProblem(ctx, inspection, `Não foi possível obter a foto (${media.code}).`, envelope.eventId);
    return 'processed';
  }
  if (sha256Hex(media.data.buffer) !== data.sha256) {
    await mediaProblem(ctx, inspection, 'Foto recebida corrompida (hash divergente).', envelope.eventId);
    return 'processed';
  }

  let stored: { id: ObjectId };
  try {
    stored = await storeFile(ctx, {
      organizationId: inspection.organizationId,
      uploadedBy: null,
      purpose: 'INSPECTION_PHOTO',
      originalName: `whatsapp-${data.slotCode ?? 'extra'}-${data.wamid.slice(-12)}.${data.mimeType.split('/')[1] ?? 'jpg'}`,
      declaredContentType: data.mimeType,
      buffer: media.data.buffer,
    });
  } catch (err) {
    await mediaProblem(ctx, inspection, `Foto rejeitada: ${(err as Error).message}`, envelope.eventId);
    return 'processed';
  }

  const now = new Date();
  await updateWithEvidence(ctx, inspection._id, (doc) => {
    if ((doc.photoEvidence ?? []).some((e) => e.wamid === data.wamid)) return null;
    const collection = doc.collection;
    const round = data.round ?? collection?.round ?? 0;
    const sameRound = collection && round === collection.round;
    const acceptingStatuses: CollectionStatus[] = ['REQUESTED', 'IN_PROGRESS', 'PARTIAL'];
    const accepting =
      doc.status === 'PENDING' && collection?.mode === 'WHATSAPP' && sameRound && acceptingStatuses.includes(collection.status);
    const required = collection?.requiredSlots.find((s) => s.code === data.slotCode) ?? null;
    const slotCode = accepting && required ? required.code : null;
    const late = !accepting;

    const evidence: PhotoEvidence = {
      slotCode: late ? data.slotCode : slotCode,
      slotLabel: required?.label ?? data.slotCode ?? 'Foto adicional',
      fileId: stored.id,
      source: 'WHATSAPP',
      receivedAt: now,
      externalMediaId: data.mediaRef.slice(0, 24),
      sha256: data.sha256,
      wamid: data.wamid,
      round,
      late,
      supersededAt: null,
    };
    const list = [...(doc.photoEvidence ?? [])].map((e) =>
      !late && slotCode && e.slotCode === slotCode && !e.supersededAt ? { ...e, supersededAt: now } : e,
    );
    list.push(evidence);

    const set: Record<string, unknown> = { photoEvidence: list };
    if (!late) {
      set.photos = currentPhotos(list);
      if (slotCode && collection) {
        const received = [...new Set([...collection.receivedSlots, slotCode])];
        set['collection.receivedSlots'] = received;
        set['collection.status'] = 'PARTIAL';
        set['collection.respondedAt'] = collection.respondedAt ?? now;
        set['collection.updatedAt'] = now;
      }
    }
    return { set };
  });

  const after = await ctx.mongo.collections.inspections.findOne({ _id: inspection._id });
  const last = after?.photoEvidence?.find((e) => e.wamid === data.wamid);
  if (last?.late) {
    await createNotification(ctx, {
      organizationId: inspection.organizationId,
      type: 'INSPECTION',
      severity: 'INFO',
      title: 'Foto recebida fora da coleta',
      message: `${inspection.responsibleName} enviou uma foto após o encerramento da coleta. Registrada como evidência adicional.`,
      entityType: 'inspection',
      entityId: inspection._id,
      targetPath: `/dashboard/inspections/${inspection.vehicleId.toHexString()}`,
      dedupeKey: `wa-late:${data.wamid}`,
    });
  }
  return 'processed';
}

async function mediaProblem(ctx: AppContext, inspection: InspectionDoc, message: string, eventId: string): Promise<void> {
  await createNotification(ctx, {
    organizationId: inspection.organizationId,
    type: 'INSPECTION',
    severity: 'WARNING',
    title: 'Problema com foto da vistoria',
    message: `${inspection.responsibleName}: ${message}`,
    entityType: 'inspection',
    entityId: inspection._id,
    targetPath: `/dashboard/inspections/${inspection.vehicleId.toHexString()}`,
    dedupeKey: `wa-media-problem:${eventId}`,
  });
}

async function handleTextReceived(
  ctx: AppContext,
  envelope: WhaplyEventEnvelope,
  data: { slotCode: string; value: string },
): Promise<IngestOutcome> {
  if (data.slotCode !== ODOMETER_STEP_CODE) return 'ignored';
  const inspection = await loadInspectionForEvent(ctx, envelope);
  if (!inspection || inspection.status !== 'PENDING') return 'ignored';
  const km = Number(data.value.replace(/\D+/g, ''));
  if (!Number.isInteger(km) || km < 0 || km > 10_000_000) return 'ignored';
  await ctx.mongo.collections.inspections.updateOne(
    { _id: inspection._id, status: 'PENDING' },
    {
      $set: { odometerKm: km, 'collection.updatedAt': new Date(), updatedAt: new Date() },
      $addToSet: { 'collection.receivedSlots': ODOMETER_STEP_CODE },
      $inc: { version: 1 },
    },
  );
  return 'processed';
}

export function isCollectionComplete(doc: InspectionDoc): boolean {
  const collection = doc.collection;
  if (!collection) return false;
  const imagesOk = collection.requiredSlots.every((s) => collection.receivedSlots.includes(s.code));
  const odometerOk = !collection.requireOdometer || doc.odometerKm !== null;
  return imagesOk && odometerOk;
}

async function handleSessionCompleted(ctx: AppContext, envelope: WhaplyEventEnvelope): Promise<IngestOutcome> {
  const inspection = await loadInspectionForEvent(ctx, envelope);
  if (!inspection?.collection || inspection.status !== 'PENDING') return 'ignored';
  const now = new Date();

  if (!isCollectionComplete(inspection)) {
    await ctx.mongo.collections.inspections.updateOne(
      { _id: inspection._id, status: 'PENDING' },
      { $set: { 'collection.status': 'PARTIAL', 'collection.updatedAt': now, updatedAt: now } },
    );
    await createNotification(ctx, {
      organizationId: inspection.organizationId,
      type: 'INSPECTION',
      severity: 'WARNING',
      title: 'Coleta de fotos incompleta',
      message: `${inspection.responsibleName} encerrou a coleta sem todas as fotos exigidas.`,
      entityType: 'inspection',
      entityId: inspection._id,
      targetPath: `/dashboard/inspections/${inspection.vehicleId.toHexString()}`,
      dedupeKey: `wa-incomplete:${inspection._id.toHexString()}:r${inspection.collection.round}`,
    });
    return 'processed';
  }

  // PENDING → SUBMITTED ("aguardando revisão"). NUNCA aprova sozinho.
  const res = await ctx.mongo.collections.inspections.updateOne(
    { _id: inspection._id, status: 'PENDING', ...versionFilter(inspection) },
    {
      $set: {
        status: 'SUBMITTED',
        submittedAt: now,
        requestTokenHash: null,
        requestTokenEnc: null,
        'collection.status': 'COMPLETE',
        'collection.completedAt': now,
        'collection.updatedAt': now,
        updatedAt: now,
      },
      $inc: { version: 1 },
    },
  );
  if (res.modifiedCount === 0) throw new Error('Vistoria alterada concorrentemente — reprocessar.');
  await audit(ctx, {
    organizationId: inspection.organizationId,
    actorId: null,
    action: 'inspection.submitted',
    entityType: 'inspection',
    entityId: inspection._id,
    after: { source: 'WHATSAPP', round: inspection.collection.round, photos: inspection.photos.length },
    correlationId: inspection.collection.correlationId,
  });
  await createNotification(ctx, {
    organizationId: inspection.organizationId,
    type: 'INSPECTION',
    severity: 'INFO',
    title: 'Vistoria aguardando aprovação',
    message: `${inspection.responsibleName} enviou todas as fotos pelo WhatsApp.`,
    entityType: 'inspection',
    entityId: inspection._id,
    targetPath: `/dashboard/inspections/${inspection.vehicleId.toHexString()}`,
    dedupeKey: `wa-complete:${inspection._id.toHexString()}:r${inspection.collection.round}`,
  });
  return 'processed';
}

async function handleSessionExpired(ctx: AppContext, envelope: WhaplyEventEnvelope): Promise<IngestOutcome> {
  const inspection = await loadInspectionForEvent(ctx, envelope);
  if (!inspection?.collection) return 'ignored';
  await expireCollection(ctx, inspection, 'Prazo da coleta pelo WhatsApp encerrado (Whaply).', false);
  return 'processed';
}

async function expireCollection(ctx: AppContext, inspection: InspectionDoc, reason: string, notifyWhaply: boolean): Promise<void> {
  const now = new Date();
  const res = await ctx.mongo.collections.inspections.updateOne(
    {
      _id: inspection._id,
      status: 'PENDING',
      'collection.status': { $in: ['REQUESTED', 'IN_PROGRESS', 'PARTIAL'] },
    },
    {
      $set: { 'collection.status': 'EXPIRED', 'collection.failureReason': reason, 'collection.updatedAt': now, updatedAt: now },
      $inc: { version: 1 },
    },
  );
  if (res.modifiedCount === 0) return;
  if (notifyWhaply && inspection.collection?.sessionId) {
    await ctx.integrations.whaply.sessionCommand(inspection.collection.sessionId, { type: 'CANCEL', reason: 'expired' });
  }
  await createNotification(ctx, {
    organizationId: inspection.organizationId,
    type: 'INSPECTION',
    severity: 'WARNING',
    title: 'Coleta de vistoria expirada',
    message: `${inspection.responsibleName} não concluiu o envio das fotos no prazo.`,
    entityType: 'inspection',
    entityId: inspection._id,
    targetPath: `/dashboard/inspections/${inspection.vehicleId.toHexString()}`,
    dedupeKey: `wa-expired:${inspection._id.toHexString()}:r${inspection.collection?.round ?? 0}`,
  });
}

async function revokeConsentFromChannel(ctx: AppContext, inspection: InspectionDoc, reason: string): Promise<void> {
  if (!inspection.driverId) return;
  const now = new Date();
  const res = await ctx.mongo.collections.drivers.updateOne(
    { _id: inspection.driverId, organizationId: inspection.organizationId, 'whatsappConsent.status': 'GRANTED' },
    {
      $set: {
        'whatsappConsent.status': 'REVOKED',
        'whatsappConsent.revokedAt': now,
        'whatsappConsent.revokedSource': 'WHATSAPP_STOP',
        updatedAt: now,
      },
    },
  );
  if (res.modifiedCount === 1) {
    await audit(ctx, {
      organizationId: inspection.organizationId,
      actorId: null,
      action: 'driver.consent_revoked',
      entityType: 'driver',
      entityId: inspection.driverId,
      after: { source: 'WHATSAPP_STOP', reason },
    });
  }
}

async function handleOptOut(ctx: AppContext, envelope: WhaplyEventEnvelope): Promise<IngestOutcome> {
  const inspection = await loadInspectionForEvent(ctx, envelope);
  if (!inspection) return 'ignored';
  await revokeConsentFromChannel(ctx, inspection, 'Cliente pediu para não receber mensagens.');
  const now = new Date();
  await ctx.mongo.collections.inspections.updateOne(
    { _id: inspection._id, status: 'PENDING', 'collection.mode': 'WHATSAPP' },
    {
      $set: {
        'collection.status': 'FAILED',
        'collection.failureReason': 'Cliente pediu para não receber mensagens (opt-out).',
        'collection.updatedAt': now,
        updatedAt: now,
      },
      $inc: { version: 1 },
    },
  );
  await ctx.mongo.collections.whatsappMessages.updateMany(
    { inspectionId: inspection._id, status: { $in: ['INTENT_CREATED', 'RETRY_SCHEDULED'] } },
    { $set: { status: 'CANCELED', updatedAt: now }, $push: { events: pushEvent('canceled', 'CANCELED', 'SYSTEM', 'Opt-out do cliente') } },
  );
  await createNotification(ctx, {
    organizationId: inspection.organizationId,
    type: 'INSPECTION',
    severity: 'WARNING',
    title: 'Cliente cancelou mensagens de vistoria',
    message: `${inspection.responsibleName} pediu para não receber mensagens. Consentimento revogado.`,
    entityType: 'inspection',
    entityId: inspection._id,
    targetPath: `/dashboard/inspections/${inspection.vehicleId.toHexString()}`,
    dedupeKey: `wa-optout:${inspection._id.toHexString()}`,
  });
  return 'processed';
}

async function handleUnmatchedMedia(
  ctx: AppContext,
  envelope: WhaplyEventEnvelope,
  data: z_MediaData & { reason: string },
): Promise<IngestOutcome> {
  const c = ctx.mongo.collections;
  if (await c.unmatchedMedia.findOne({ eventId: envelope.eventId })) return 'processed';
  const inspection = await loadInspectionForEvent(ctx, envelope);
  const organization = inspection
    ? await c.organizations.findOne({ _id: inspection.organizationId })
    : await c.organizations.findOne({}, { sort: { createdAt: 1 } });
  if (!organization) return 'ignored';

  const media = await ctx.integrations.whaply.fetchMedia(data.mediaRef);
  if (!media.ok) {
    if (media.retryable) throw new Error(`Mídia indisponível: ${media.message}`);
    return 'processed';
  }
  if (sha256Hex(media.data.buffer) !== data.sha256) return 'processed';
  let fileId: ObjectId;
  try {
    const stored = await storeFile(ctx, {
      organizationId: organization._id,
      uploadedBy: null,
      purpose: 'INSPECTION_PHOTO',
      originalName: `whatsapp-sem-vinculo-${data.wamid.slice(-12)}.jpg`,
      declaredContentType: data.mimeType,
      buffer: media.data.buffer,
    });
    fileId = stored.id;
  } catch {
    return 'processed';
  }
  const now = new Date();
  try {
    await c.unmatchedMedia.insertOne({
      _id: new ObjectId(),
      organizationId: organization._id,
      eventId: envelope.eventId,
      fileId,
      wamid: data.wamid,
      sha256: data.sha256,
      reason: data.reason,
      receivedAt: now,
      status: 'PENDING',
      resolvedBy: null,
      resolvedAt: null,
      assignedInspectionId: null,
      assignedSlotCode: null,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
  }
  await createNotification(ctx, {
    organizationId: organization._id,
    type: 'INSPECTION',
    severity: 'INFO',
    title: 'Foto recebida sem vínculo',
    message: 'Uma foto chegou pelo WhatsApp sem coleta ativa. Atribua-a manualmente ou descarte.',
    targetPath: '/dashboard/messages?tab=unmatched',
    dedupeKey: `wa-unmatched:${envelope.eventId}`,
  });
  return 'processed';
}

async function handleTemplateStatus(
  ctx: AppContext,
  envelope: WhaplyEventEnvelope,
  data: { name: string; status: string; category?: string | null; reason?: string | null },
): Promise<IngestOutcome> {
  const organizations = await ctx.mongo.collections.organizations.find({}).toArray();
  const ok = data.status === 'APPROVED' && (!data.category || data.category === 'UTILITY');
  for (const org of organizations) {
    await createNotification(ctx, {
      organizationId: org._id,
      type: 'INSPECTION',
      severity: ok ? 'INFO' : 'CRITICAL',
      title: ok ? 'Template de vistoria aprovado' : 'Template de vistoria indisponível',
      message: ok
        ? `O template ${data.name} está aprovado para uso.`
        : `O template ${data.name} está ${data.status}${data.category ? ` (${data.category})` : ''}. A coleta pelo WhatsApp usará o link manual até a regularização.`,
      targetPath: '/dashboard/messages',
      dedupeKey: `wa-template:${data.name}:${data.status}:${data.category ?? ''}:${envelope.eventId}`,
    });
  }
  return 'processed';
}

/* ------------------- lembretes, expiração e TTL -------------------- */

export async function runCollectionLifecycle(ctx: AppContext, now = new Date()): Promise<{ reminders: number; expired: number }> {
  const c = ctx.mongo.collections;
  let reminders = 0;
  let expired = 0;
  const active = await c.inspections
    .find({
      status: 'PENDING',
      'collection.mode': 'WHATSAPP',
      'collection.status': { $in: ['REQUESTED', 'IN_PROGRESS', 'PARTIAL'] },
      'collection.requestedAt': { $ne: null },
    })
    .limit(200)
    .toArray();
  const orgCache = new Map<string, OrganizationDoc | null>();

  for (const inspection of active) {
    const key = inspection.organizationId.toHexString();
    if (!orgCache.has(key)) orgCache.set(key, await c.organizations.findOne({ _id: inspection.organizationId }));
    const settings = getWhatsappSettings(orgCache.get(key) ?? null);
    const collection = inspection.collection!;
    const requestedAt = collection.requestedAt!.getTime();

    if (requestedAt + settings.collectionTtlHours * 3600_000 <= now.getTime()) {
      await expireCollection(ctx, inspection, 'Prazo da coleta encerrado sem todas as fotos.', true);
      expired += 1;
      continue;
    }
    const nextReminder = collection.remindersSent + 1;
    if (
      nextReminder <= settings.maxReminders &&
      requestedAt + settings.reminderAfterHours * 3600_000 * nextReminder <= now.getTime()
    ) {
      const claim = await c.inspections.findOneAndUpdate(
        { _id: inspection._id, 'collection.remindersSent': collection.remindersSent, status: 'PENDING' },
        { $inc: { 'collection.remindersSent': 1, version: 1 }, $set: { updatedAt: now } },
        { returnDocument: 'after' },
      );
      if (!claim) continue;
      const res = await createMessageIntent(ctx, {
        inspection: claim,
        kind: 'REMINDER',
        idempotencyKey: messageIdempotencyKey(claim._id, 'REMINDER', collection.round, nextReminder),
        createdBy: null,
      }).catch(() => null);
      if (res?.created) reminders += 1;
    }
  }
  return { reminders, expired };
}

/* ------------------------- correção de fotos ----------------------- */

export async function requestCorrection(
  ctx: AppContext,
  params: { organizationId: ObjectId; inspectionId: ObjectId; actorId: ObjectId; slots: string[]; reason: string },
): Promise<{ guided: boolean; link: string | null; messageId: string | null }> {
  const c = ctx.mongo.collections;
  const inspection = await c.inspections.findOne({ _id: params.inspectionId, organizationId: params.organizationId });
  if (!inspection) throw notFound('Vistoria não encontrada.');
  if (inspection.status !== 'SUBMITTED') {
    throw conflict('Só é possível solicitar correção de vistorias aguardando revisão.');
  }
  const organization = await c.organizations.findOne({ _id: params.organizationId });
  const settings = getWhatsappSettings(organization);
  const slotDocs = await c.inspectionPhotoSlots.find({ organizationId: params.organizationId }).toArray();
  const labelOf = (code: string) =>
    code === ODOMETER_STEP_CODE
      ? 'Quilometragem'
      : (inspection.photos.find((p) => p.slotCode === code)?.slotLabel ?? slotDocs.find((s) => s.code === code)?.label ?? null);
  const unknown = params.slots.filter((s) => !labelOf(s));
  if (unknown.length > 0) throw badRequest(`Ângulos desconhecidos: ${unknown.join(', ')}.`);

  const driver = inspection.driverId
    ? await c.drivers.findOne({ _id: inspection.driverId, organizationId: params.organizationId })
    : null;
  const plan = planCollection(ctx, {
    organization,
    driver,
    phone: inspection.phone,
    scheduledAt: inspection.scheduledAt,
  });

  const round = (inspection.correctionRound ?? 0) + 1;
  const now = new Date();
  const imageSlots = params.slots.filter((s) => s !== ODOMETER_STEP_CODE);
  const requireOdometer = params.slots.includes(ODOMETER_STEP_CODE);
  const evidence = (inspection.photoEvidence ?? []).map((e) =>
    e.slotCode && imageSlots.includes(e.slotCode) && !e.supersededAt ? { ...e, supersededAt: now } : e,
  );
  // Evidências antigas (antes do versionamento) entram no histórico.
  for (const p of inspection.photos) {
    if (!evidence.some((e) => e.fileId.equals(p.fileId))) {
      evidence.push({
        slotCode: p.slotCode,
        slotLabel: p.slotLabel,
        fileId: p.fileId,
        source: 'WEB',
        receivedAt: inspection.submittedAt ?? inspection.createdAt,
        externalMediaId: null,
        sha256: null,
        wamid: null,
        round: inspection.correctionRound ?? 0,
        late: false,
        supersededAt: imageSlots.includes(p.slotCode) ? now : null,
      });
    }
  }
  const requiredSlots = imageSlots.map((code, i) => ({
    code,
    label: labelOf(code)!,
    order: i,
    instruction: slotDocs.find((s) => s.code === code)?.instruction ?? settings.instructions[code] ?? null,
  }));
  const collection: InspectionCollection = {
    ...newCollection(plan, requiredSlots, round),
    status: plan.guided ? 'REQUESTED' : plan.status,
    requireOdometer,
    requestedAt: plan.guided ? now : null,
  };

  const res = await c.inspections.findOneAndUpdate(
    { _id: inspection._id, status: 'SUBMITTED', ...versionFilter(inspection) },
    {
      $set: {
        status: 'PENDING',
        submittedAt: null,
        correctionRound: round,
        photoEvidence: evidence,
        photos: currentPhotos(evidence),
        odometerKm: requireOdometer ? null : inspection.odometerKm,
        collection,
        updatedAt: now,
      },
      $push: { correctionRequests: { slots: params.slots, reason: params.reason, requestedBy: params.actorId, at: now } },
      $inc: { version: 1 },
    },
    { returnDocument: 'after' },
  );
  if (!res) throw conflict('A vistoria foi alterada por outra operação. Recarregue e tente novamente.');

  const token = await ensurePublicToken(ctx, res, true);
  await audit(ctx, {
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: 'inspection.correction_requested',
    entityType: 'inspection',
    entityId: inspection._id,
    after: { slots: params.slots, reason: params.reason, round, channel: plan.guided ? 'WHATSAPP' : 'WEB_LINK' },
    correlationId: collection.correlationId,
  });

  if (!plan.guided) return { guided: false, link: publicLink(ctx, token), messageId: null };
  const fresh = await c.inspections.findOne({ _id: inspection._id });
  const intent = await createMessageIntent(ctx, {
    inspection: fresh!,
    kind: 'CORRECTION',
    idempotencyKey: messageIdempotencyKey(inspection._id, 'CORRECTION', round, 0),
    createdBy: params.actorId,
    correction: {
      slots: params.slots.map((code) => ({ code, label: labelOf(code)! })),
      reason: params.reason,
      requireOdometer,
    },
  });
  return { guided: true, link: publicLink(ctx, token), messageId: intent.message._id.toHexString() };
}

/* ----------------------- operações manuais ------------------------- */

/** Reenvio autorizado pelo operador: NOVA chave de idempotência. */
export async function resendMessage(
  ctx: AppContext,
  params: { organizationId: ObjectId; messageId: ObjectId; actorId: ObjectId },
): Promise<WhatsappMessageDoc> {
  const c = ctx.mongo.collections;
  const original = await c.whatsappMessages.findOne({ _id: params.messageId, organizationId: params.organizationId });
  if (!original) throw notFound('Mensagem não encontrada.');
  if (original.kind === 'SESSION_PROMPT') throw badRequest('Instruções da coleta não podem ser reenviadas.');
  if (!original.inspectionId) throw badRequest('Mensagem sem vistoria vinculada.');
  const inspection = await c.inspections.findOne({ _id: original.inspectionId, organizationId: params.organizationId });
  if (!inspection) throw notFound('Vistoria não encontrada.');
  if (inspection.status !== 'PENDING') throw conflict('A vistoria não está mais aguardando fotos.');
  if (!inspection.collection || inspection.collection.mode !== 'WHATSAPP') {
    throw conflict('Esta vistoria não usa a coleta pelo WhatsApp.');
  }
  const active = await c.whatsappMessages.countDocuments({
    inspectionId: inspection._id,
    status: { $in: ['INTENT_CREATED', 'RETRY_SCHEDULED', 'SUBMITTED_TO_WHAPLY'] },
  });
  if (active > 0) throw conflict('Já existe um envio em andamento para esta vistoria.');

  const now = new Date();
  // Reabre a coleta (falha/expiração) para a mesma rodada.
  await c.inspections.updateOne(
    { _id: inspection._id, status: 'PENDING' },
    {
      $set: {
        'collection.status': 'REQUESTED',
        'collection.requestedAt': now,
        'collection.failureReason': null,
        'collection.updatedAt': now,
        updatedAt: now,
      },
      $inc: { version: 1 },
    },
  );
  const fresh = await c.inspections.findOne({ _id: inspection._id });
  const kind = original.kind === 'REMINDER' ? 'INSPECTION_REQUEST' : original.kind;
  const correctionMeta = inspection.correctionRequests?.at(-1);
  const result = await createMessageIntent(ctx, {
    inspection: fresh!,
    kind,
    idempotencyKey: `manual:${randomUUID()}`,
    createdBy: params.actorId,
    manualOf: original._id,
    correction:
      kind === 'CORRECTION' && correctionMeta
        ? {
            slots: correctionMeta.slots.map((code) => ({
              code,
              label:
                code === ODOMETER_STEP_CODE
                  ? 'Quilometragem'
                  : (fresh!.collection!.requiredSlots.find((s) => s.code === code)?.label ?? code),
            })),
            reason: correctionMeta.reason,
            requireOdometer: correctionMeta.slots.includes(ODOMETER_STEP_CODE),
          }
        : undefined,
  });
  await audit(ctx, {
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: 'whatsapp.message_resent',
    entityType: 'whatsappMessage',
    entityId: result.message._id,
    after: { manualOf: original._id.toHexString(), kind },
  });
  return result.message;
}

/** Reprocessa falha de TRANSPORTE com a MESMA chave (não é novo envio). */
export async function retryFailedMessage(
  ctx: AppContext,
  params: { organizationId: ObjectId; messageId: ObjectId; actorId: ObjectId },
): Promise<void> {
  const c = ctx.mongo.collections;
  const message = await c.whatsappMessages.findOne({ _id: params.messageId, organizationId: params.organizationId });
  if (!message) throw notFound('Mensagem não encontrada.');
  if (message.status !== 'FAILED' || message.lastError?.source !== 'TRANSPORT') {
    throw conflict('Somente falhas de comunicação podem ser reprocessadas. Use "Reenviar" para um novo envio.');
  }
  const now = new Date();
  await c.whatsappMessages.updateOne(
    { _id: message._id, status: 'FAILED' },
    {
      $set: { status: 'RETRY_SCHEDULED', attempts: 0, nextAttemptAt: now, leaseUntil: null, updatedAt: now },
      $push: { events: { $each: [pushEvent('manual.retry', 'RETRY_SCHEDULED', 'YUDIRECT', 'Reprocessamento manual (mesma chave)')], $slice: -200 } },
    },
  );
  if (message.inspectionId) {
    await c.inspections.updateOne(
      { _id: message.inspectionId, status: 'PENDING', 'collection.status': 'FAILED' },
      { $set: { 'collection.status': 'REQUESTED', 'collection.failureReason': null, updatedAt: now } },
    );
  }
  await audit(ctx, {
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: 'whatsapp.message_retried',
    entityType: 'whatsappMessage',
    entityId: message._id,
  });
}

/** Cancela intenções e a sessão quando a vistoria é cancelada. */
export async function cancelCollectionForInspection(ctx: AppContext, inspection: InspectionDoc): Promise<void> {
  const now = new Date();
  await ctx.mongo.collections.whatsappMessages.updateMany(
    { inspectionId: inspection._id, status: { $in: ['INTENT_CREATED', 'RETRY_SCHEDULED'] } },
    {
      $set: { status: 'CANCELED', updatedAt: now },
      $push: { events: pushEvent('canceled', 'CANCELED', 'YUDIRECT', 'Vistoria cancelada') },
    },
  );
  if (inspection.collection?.sessionId) {
    await ctx.integrations.whaply.sessionCommand(inspection.collection.sessionId, { type: 'CANCEL', reason: 'inspection_canceled' });
  }
}

/** Atribuição manual de foto sem vínculo (auditada). */
export async function assignUnmatchedMedia(
  ctx: AppContext,
  params: { organizationId: ObjectId; id: ObjectId; actorId: ObjectId; inspectionId: ObjectId; slotCode: string },
): Promise<void> {
  const c = ctx.mongo.collections;
  const item = await c.unmatchedMedia.findOne({ _id: params.id, organizationId: params.organizationId, status: 'PENDING' });
  if (!item) throw notFound('Foto pendente não encontrada.');
  const inspection = await c.inspections.findOne({ _id: params.inspectionId, organizationId: params.organizationId });
  if (!inspection) throw notFound('Vistoria não encontrada.');
  if (inspection.status !== 'PENDING' && inspection.status !== 'SUBMITTED') {
    throw conflict('A vistoria já foi decidida; não é possível atribuir novas fotos.');
  }
  const slot = await c.inspectionPhotoSlots.findOne({ organizationId: params.organizationId, code: params.slotCode });
  if (!slot) throw badRequest('Ângulo inválido.');
  const now = new Date();
  await updateWithEvidence(ctx, inspection._id, (doc) => {
    const list = (doc.photoEvidence ?? []).map((e) =>
      e.slotCode === slot.code && !e.supersededAt ? { ...e, supersededAt: now } : e,
    );
    list.push({
      slotCode: slot.code,
      slotLabel: slot.label,
      fileId: item.fileId,
      source: 'OPERATOR',
      receivedAt: now,
      externalMediaId: null,
      sha256: item.sha256,
      wamid: item.wamid,
      round: doc.correctionRound ?? 0,
      late: false,
      supersededAt: null,
    });
    const set: Record<string, unknown> = { photoEvidence: list, photos: currentPhotos(list) };
    if (doc.collection) set['collection.receivedSlots'] = [...new Set([...doc.collection.receivedSlots, slot.code])];
    return { set };
  });
  await c.unmatchedMedia.updateOne(
    { _id: item._id, status: 'PENDING' },
    {
      $set: {
        status: 'ASSIGNED',
        resolvedBy: params.actorId,
        resolvedAt: now,
        assignedInspectionId: inspection._id,
        assignedSlotCode: slot.code,
        updatedAt: now,
      },
    },
  );
  await audit(ctx, {
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: 'inspection.photo_assigned',
    entityType: 'inspection',
    entityId: inspection._id,
    after: { slotCode: slot.code, unmatchedMediaId: item._id.toHexString() },
  });
}

