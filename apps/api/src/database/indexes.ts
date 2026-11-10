import type { MongoContext } from './mongo.js';

/**
 * Criação idempotente de índices. Todo índice de domínio começa por
 * `organizationId` para garantir isolamento e seletividade por tenant.
 */
export async function ensureIndexes(ctx: MongoContext): Promise<void> {
  const c = ctx.collections;

  await c.users.createIndexes([{ key: { emailLower: 1 }, unique: true, name: 'uniq_email' }]);

  await c.memberships.createIndexes([
    { key: { organizationId: 1, userId: 1 }, unique: true, name: 'uniq_org_user' },
    { key: { userId: 1, status: 1 }, name: 'by_user' },
  ]);

  await c.invitations.createIndexes([
    { key: { tokenHash: 1 }, unique: true, name: 'uniq_token' },
    {
      key: { organizationId: 1, emailLower: 1 },
      unique: true,
      partialFilterExpression: { status: 'PENDING' },
      name: 'uniq_pending_invite',
    },
    { key: { organizationId: 1, createdAt: -1 }, name: 'by_org_created' },
  ]);

  await c.sessions.createIndexes([
    { key: { tokenHash: 1 }, unique: true, name: 'uniq_session_token' },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl_session' },
    { key: { userId: 1 }, name: 'by_user' },
  ]);

  await c.passwordResets.createIndexes([
    { key: { tokenHash: 1 }, unique: true, name: 'uniq_reset_token' },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl_reset' },
  ]);

  await c.files.createIndexes([
    { key: { organizationId: 1, purpose: 1, createdAt: -1 }, name: 'by_org_purpose' },
    { key: { storageKey: 1 }, unique: true, name: 'uniq_storage_key' },
  ]);

  await c.vehicles.createIndexes([
    {
      key: { organizationId: 1, plate: 1 },
      unique: true,
      partialFilterExpression: { archivedAt: null },
      name: 'uniq_org_plate',
    },
    {
      key: { organizationId: 1, renavam: 1 },
      unique: true,
      partialFilterExpression: { renavam: { $type: 'string' }, archivedAt: null },
      name: 'uniq_org_renavam',
    },
    {
      key: { organizationId: 1, vin: 1 },
      unique: true,
      partialFilterExpression: { vin: { $type: 'string' }, archivedAt: null },
      name: 'uniq_org_vin',
    },
    { key: { organizationId: 1, status: 1, createdAt: -1, _id: -1 }, name: 'by_org_status_created' },
    { key: { organizationId: 1, brandLower: 1, modelLower: 1 }, name: 'by_org_brand_model' },
  ]);

  await c.drivers.createIndexes([
    {
      key: { organizationId: 1, cpfLookupHash: 1 },
      unique: true,
      partialFilterExpression: { cpfLookupHash: { $type: 'string' }, archivedAt: null },
      name: 'uniq_org_cpf',
    },
    { key: { organizationId: 1, status: 1, fullNameFold: 1, _id: 1 }, name: 'by_org_status_name' },
    { key: { organizationId: 1, 'cnh.expiresAt': 1 }, name: 'by_cnh_expiry' },
    { key: { organizationId: 1, phone: 1 }, name: 'by_phone' },
  ]);

  await c.rentals.createIndexes([
    { key: { organizationId: 1, rentalNumber: 1 }, unique: true, name: 'uniq_org_rental_number' },
    { key: { organizationId: 1, vehicleId: 1, status: 1, startDate: 1 }, name: 'by_vehicle_status' },
    { key: { organizationId: 1, driverId: 1, status: 1 }, name: 'by_driver_status' },
    { key: { organizationId: 1, status: 1, createdAt: -1, _id: -1 }, name: 'by_org_status_created' },
  ]);

  await c.maintenanceOrders.createIndexes([
    { key: { organizationId: 1, orderNumber: 1 }, unique: true, name: 'uniq_org_order_number' },
    { key: { organizationId: 1, vehicleId: 1, performedAt: -1, _id: -1 }, name: 'by_vehicle_performed' },
    { key: { organizationId: 1, status: 1, performedAt: -1 }, name: 'by_org_status' },
  ]);

  await c.inspectionPhotoSlots.createIndexes([
    { key: { organizationId: 1, code: 1 }, unique: true, name: 'uniq_org_slot_code' },
    { key: { organizationId: 1, order: 1 }, name: 'by_org_order' },
  ]);

  await c.inspections.createIndexes([
    { key: { organizationId: 1, vehicleId: 1, scheduledAt: -1, _id: -1 }, name: 'by_vehicle_scheduled' },
    { key: { organizationId: 1, status: 1, dueDate: 1 }, name: 'by_org_status_due' },
    { key: { organizationId: 1, rentalId: 1 }, name: 'by_rental' },
    {
      key: { requestTokenHash: 1 },
      unique: true,
      partialFilterExpression: { requestTokenHash: { $type: 'string' } },
      name: 'uniq_request_token',
    },
    // Disparo automático pelo WhatsApp (plano §7).
    {
      key: { 'collection.status': 1, scheduledSendAt: 1 },
      partialFilterExpression: { 'collection.mode': 'WHATSAPP' },
      name: 'by_collection_due',
    },
    // Uma única vistoria gerada por regra para a mesma locação e data.
    {
      key: { organizationId: 1, rentalId: 1, scheduledAt: 1 },
      unique: true,
      partialFilterExpression: { source: 'SCHEDULED' },
      name: 'uniq_scheduled_inspection',
    },
  ]);

  await c.bankAccounts.createIndexes([
    { key: { organizationId: 1, active: 1 }, name: 'by_org_active' },
    {
      key: { organizationId: 1, isDefault: 1 },
      unique: true,
      partialFilterExpression: { isDefault: true },
      name: 'uniq_default_account',
    },
  ]);

  await c.bankTransactions.createIndexes([
    { key: { organizationId: 1, bankAccountId: 1, occurredAt: 1, _id: 1 }, name: 'by_account_date' },
    {
      key: { organizationId: 1, dedupeKey: 1 },
      unique: true,
      partialFilterExpression: { dedupeKey: { $type: 'string' } },
      name: 'uniq_dedupe',
    },
    { key: { organizationId: 1, originType: 1, originId: 1 }, name: 'by_origin' },
  ]);

  await c.expenseCategories.createIndexes([
    { key: { organizationId: 1, slug: 1 }, unique: true, name: 'uniq_org_slug' },
  ]);

  await c.payables.createIndexes([
    { key: { organizationId: 1, dueDate: 1, status: 1 }, name: 'by_org_due_status' },
    { key: { organizationId: 1, categoryId: 1, status: 1 }, name: 'by_org_category' },
    { key: { organizationId: 1, vehicleId: 1 }, name: 'by_vehicle' },
    { key: { organizationId: 1, createdAt: -1, _id: -1 }, name: 'by_org_created' },
    {
      key: { organizationId: 1, 'recurring.seriesId': 1, 'recurring.period': 1 },
      unique: true,
      partialFilterExpression: { 'recurring.seriesId': { $type: 'string' } },
      name: 'uniq_recurring_period',
    },
  ]);

  await c.receivables.createIndexes([
    { key: { organizationId: 1, dueDate: 1, status: 1 }, name: 'by_org_due_status' },
    { key: { organizationId: 1, driverId: 1, status: 1 }, name: 'by_driver' },
    { key: { organizationId: 1, createdAt: -1, _id: -1 }, name: 'by_org_created' },
    {
      key: { organizationId: 1, rentalId: 1, expectedPeriod: 1 },
      unique: true,
      partialFilterExpression: { expectedPeriod: { $type: 'string' }, rentalId: { $type: 'objectId' } },
      name: 'uniq_rental_period',
    },
  ]);

  await c.payments.createIndexes([
    { key: { organizationId: 1, sourceType: 1, sourceId: 1, paidAt: 1 }, name: 'by_source' },
    {
      key: { organizationId: 1, idempotencyKey: 1 },
      unique: true,
      partialFilterExpression: { idempotencyKey: { $type: 'string' } },
      name: 'uniq_idempotency',
    },
  ]);

  await c.notifications.createIndexes([
    { key: { organizationId: 1, userId: 1, readAt: 1, createdAt: -1 }, name: 'by_user_read' },
    { key: { organizationId: 1, type: 1, createdAt: -1, _id: -1 }, name: 'by_org_type' },
    { key: { organizationId: 1, dedupeKey: 1 }, unique: true, name: 'uniq_dedupe' },
  ]);

  await c.messageTemplates.createIndexes([
    { key: { organizationId: 1, name: 1 }, unique: true, name: 'uniq_org_template_name' },
  ]);

  await c.messageDispatches.createIndexes([
    { key: { organizationId: 1, createdAt: -1, _id: -1 }, name: 'by_org_created' },
  ]);

  await c.subscriptions.createIndexes([
    { key: { organizationId: 1 }, unique: true, name: 'uniq_org_subscription' },
  ]);

  await c.billingInvoices.createIndexes([
    { key: { organizationId: 1, dueDate: -1 }, name: 'by_org_due' },
    {
      key: { organizationId: 1, providerInvoiceId: 1 },
      unique: true,
      partialFilterExpression: { providerInvoiceId: { $type: 'string' } },
      name: 'uniq_provider_invoice',
    },
  ]);

  await c.auditLogs.createIndexes([
    { key: { organizationId: 1, occurredAt: -1 }, name: 'by_org_occurred' },
    { key: { organizationId: 1, entityType: 1, entityId: 1, occurredAt: -1 }, name: 'by_entity' },
  ]);

  await c.importDrafts.createIndexes([
    { key: { token: 1 }, unique: true, name: 'uniq_import_token' },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl_import' },
  ]);

  /* ----------------- integração Whaply (plano §4.1) ---------------- */
  await c.whatsappMessages.createIndexes([
    { key: { organizationId: 1, idempotencyKey: 1 }, unique: true, name: 'uniq_idempotency' },
    { key: { status: 1, nextAttemptAt: 1 }, name: 'by_status_next' },
    { key: { inspectionId: 1, createdAt: 1 }, name: 'by_inspection' },
    {
      key: { wamid: 1 },
      unique: true,
      partialFilterExpression: { wamid: { $type: 'string' } },
      name: 'uniq_wamid',
    },
    {
      key: { whaplyRequestId: 1 },
      unique: true,
      partialFilterExpression: { whaplyRequestId: { $type: 'string' } },
      name: 'uniq_whaply_request',
    },
    { key: { organizationId: 1, createdAt: -1 }, name: 'by_org_created' },
  ]);
  await c.integrationInbox.createIndexes([
    { key: { seq: 1 }, name: 'by_seq' },
    { key: { processedAt: 1, receivedAt: 1 }, name: 'by_pending' },
  ]);
  await c.integrationNonces.createIndexes([
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl_nonce' },
  ]);
  await c.messagingRates.createIndexes([
    { key: { organizationId: 1, category: 1, effectiveFrom: -1 }, name: 'by_category_effective' },
  ]);
  await c.unmatchedMedia.createIndexes([
    { key: { eventId: 1 }, unique: true, name: 'uniq_event' },
    { key: { organizationId: 1, status: 1, receivedAt: -1 }, name: 'by_org_status' },
  ]);
}
