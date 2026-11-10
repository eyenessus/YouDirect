import { MongoClient, type ClientSession, type Db, type Collection } from 'mongodb';
import type { Env } from '../config/env.js';
import type {
  AuditLogDoc,
  BankAccountDoc,
  BankTransactionDoc,
  BillingInvoiceDoc,
  CounterDoc,
  DriverDoc,
  ExpenseCategoryDoc,
  FileDoc,
  ImportDraftDoc,
  LoginAttemptDoc,
  InspectionDoc,
  InvitationDoc,
  MaintenanceOrderDoc,
  MembershipDoc,
  MessageDispatchDoc,
  MessageTemplateDoc,
  NotificationDoc,
  OrganizationDoc,
  PasswordResetDoc,
  PayableDoc,
  PaymentDoc,
  RentalPaymentDoc,
  PhotoSlotDoc,
  ReceivableDoc,
  RentalDoc,
  SessionDoc,
  SubscriptionDoc,
  UserDoc,
  VehicleDoc,
  WhatsappMessageDoc,
  IntegrationInboxDoc,
  IntegrationNonceDoc,
  IntegrationCursorDoc,
  JobLeaseDoc,
  MessagingRateDoc,
  UnmatchedMediaDoc,
  TrafficFineDoc,
  DriverAccessTokenDoc,
  DriverSessionDoc,
  MaintenanceRequestDoc,
  RentalLeadDoc,
  PixChargeDoc,
  BillingReminderDoc,
  DamagePriceDoc,
  InspectionDamageDoc,
  DepositSettlementDoc,
  ContractSignatureDoc,
} from './types.js';

export interface Collections {
  organizations: Collection<OrganizationDoc>;
  users: Collection<UserDoc>;
  memberships: Collection<MembershipDoc>;
  invitations: Collection<InvitationDoc>;
  sessions: Collection<SessionDoc>;
  passwordResets: Collection<PasswordResetDoc>;
  files: Collection<FileDoc>;
  vehicles: Collection<VehicleDoc>;
  drivers: Collection<DriverDoc>;
  rentals: Collection<RentalDoc>;
  maintenanceOrders: Collection<MaintenanceOrderDoc>;
  inspectionPhotoSlots: Collection<PhotoSlotDoc>;
  inspections: Collection<InspectionDoc>;
  bankAccounts: Collection<BankAccountDoc>;
  bankTransactions: Collection<BankTransactionDoc>;
  expenseCategories: Collection<ExpenseCategoryDoc>;
  payables: Collection<PayableDoc>;
  receivables: Collection<ReceivableDoc>;
  payments: Collection<PaymentDoc>;
  rentalPayments: Collection<RentalPaymentDoc>;
  trafficFines: Collection<TrafficFineDoc>;
  driverAccessTokens: Collection<DriverAccessTokenDoc>;
  driverSessions: Collection<DriverSessionDoc>;
  maintenanceRequests: Collection<MaintenanceRequestDoc>;
  rentalLeads: Collection<RentalLeadDoc>;
  pixCharges: Collection<PixChargeDoc>;
  billingReminders: Collection<BillingReminderDoc>;
  damagePrices: Collection<DamagePriceDoc>;
  inspectionDamages: Collection<InspectionDamageDoc>;
  depositSettlements: Collection<DepositSettlementDoc>;
  contractSignatures: Collection<ContractSignatureDoc>;
  notifications: Collection<NotificationDoc>;
  messageTemplates: Collection<MessageTemplateDoc>;
  messageDispatches: Collection<MessageDispatchDoc>;
  subscriptions: Collection<SubscriptionDoc>;
  billingInvoices: Collection<BillingInvoiceDoc>;
  auditLogs: Collection<AuditLogDoc>;
  counters: Collection<CounterDoc>;
  importDrafts: Collection<ImportDraftDoc>;
  loginAttempts: Collection<LoginAttemptDoc>;
  whatsappMessages: Collection<WhatsappMessageDoc>;
  integrationInbox: Collection<IntegrationInboxDoc>;
  integrationNonces: Collection<IntegrationNonceDoc>;
  integrationCursors: Collection<IntegrationCursorDoc>;
  jobLeases: Collection<JobLeaseDoc>;
  messagingRates: Collection<MessagingRateDoc>;
  unmatchedMedia: Collection<UnmatchedMediaDoc>;
}

export interface MongoContext {
  client: MongoClient;
  db: Db;
  collections: Collections;
  supportsTransactions: boolean;
  close: () => Promise<void>;
}

function buildCollections(db: Db): Collections {
  return {
    organizations: db.collection<OrganizationDoc>('organizations'),
    users: db.collection<UserDoc>('users'),
    memberships: db.collection<MembershipDoc>('memberships'),
    invitations: db.collection<InvitationDoc>('invitations'),
    sessions: db.collection<SessionDoc>('sessions'),
    passwordResets: db.collection<PasswordResetDoc>('passwordResets'),
    files: db.collection<FileDoc>('files'),
    vehicles: db.collection<VehicleDoc>('vehicles'),
    drivers: db.collection<DriverDoc>('drivers'),
    rentals: db.collection<RentalDoc>('rentals'),
    maintenanceOrders: db.collection<MaintenanceOrderDoc>('maintenanceOrders'),
    inspectionPhotoSlots: db.collection<PhotoSlotDoc>('inspectionPhotoSlots'),
    inspections: db.collection<InspectionDoc>('inspections'),
    bankAccounts: db.collection<BankAccountDoc>('bankAccounts'),
    bankTransactions: db.collection<BankTransactionDoc>('bankTransactions'),
    expenseCategories: db.collection<ExpenseCategoryDoc>('expenseCategories'),
    payables: db.collection<PayableDoc>('payables'),
    receivables: db.collection<ReceivableDoc>('receivables'),
    payments: db.collection<PaymentDoc>('payments'),
    rentalPayments: db.collection<RentalPaymentDoc>('rentalPayments'),
    trafficFines: db.collection<TrafficFineDoc>('trafficFines'),
    driverAccessTokens: db.collection<DriverAccessTokenDoc>('driverAccessTokens'),
    driverSessions: db.collection<DriverSessionDoc>('driverSessions'),
    maintenanceRequests: db.collection<MaintenanceRequestDoc>('maintenanceRequests'),
    rentalLeads: db.collection<RentalLeadDoc>('rentalLeads'),
    pixCharges: db.collection<PixChargeDoc>('pixCharges'),
    billingReminders: db.collection<BillingReminderDoc>('billingReminders'),
    damagePrices: db.collection<DamagePriceDoc>('damagePrices'),
    inspectionDamages: db.collection<InspectionDamageDoc>('inspectionDamages'),
    depositSettlements: db.collection<DepositSettlementDoc>('depositSettlements'),
    contractSignatures: db.collection<ContractSignatureDoc>('contractSignatures'),
    notifications: db.collection<NotificationDoc>('notifications'),
    messageTemplates: db.collection<MessageTemplateDoc>('messageTemplates'),
    messageDispatches: db.collection<MessageDispatchDoc>('messageDispatches'),
    subscriptions: db.collection<SubscriptionDoc>('subscriptions'),
    billingInvoices: db.collection<BillingInvoiceDoc>('billingInvoices'),
    auditLogs: db.collection<AuditLogDoc>('auditLogs'),
    counters: db.collection<CounterDoc>('counters'),
    importDrafts: db.collection<ImportDraftDoc>('importDrafts'),
    loginAttempts: db.collection<LoginAttemptDoc>('loginAttempts'),
    whatsappMessages: db.collection<WhatsappMessageDoc>('whatsappMessages'),
    integrationInbox: db.collection<IntegrationInboxDoc>('integrationInbox'),
    integrationNonces: db.collection<IntegrationNonceDoc>('integrationNonces'),
    integrationCursors: db.collection<IntegrationCursorDoc>('integrationCursors'),
    jobLeases: db.collection<JobLeaseDoc>('jobLeases'),
    messagingRates: db.collection<MessagingRateDoc>('messagingRates'),
    unmatchedMedia: db.collection<UnmatchedMediaDoc>('unmatchedMedia'),
  };
}

async function detectTransactionSupport(client: MongoClient): Promise<boolean> {
  try {
    const admin = client.db().admin();
    const info = (await admin.command({ hello: 1 })) as { setName?: string; msg?: string };
    return Boolean(info.setName) || info.msg === 'isdbgrid';
  } catch {
    return false;
  }
}

/**
 * Conecta ao MongoDB. Quando `MONGODB_URI` não está definido em
 * desenvolvimento/teste, sobe um `mongodb-memory-server` com replica set
 * (necessário para transações multi-documento). Em produção a URI é
 * obrigatória — ver docs/ASSUMPTIONS.md (A-INFRA-01).
 */
export async function connectMongo(env: Env): Promise<MongoContext> {
  let uri = env.MONGODB_URI;
  let stopMemoryServer: (() => Promise<void>) | null = null;

  if (!uri) {
    if (env.NODE_ENV === 'production') {
      throw new Error('MONGODB_URI é obrigatório em produção.');
    }
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');

    // O diretório de dados fica onde o ambiente mandar (padrão: pasta do
    // projeto), e não no temp do sistema — em máquinas com o disco do
    // sistema cheio o mongod falha ao iniciar.
    const baseDir = env.MONGO_MEMORY_DB_PATH;
    await mkdir(baseDir, { recursive: true });
    const dbPath = await mkdtemp(join(baseDir, 'instance-'));

    const replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
      instanceOpts: [{ dbPath, storageEngine: 'wiredTiger' }],
    });
    uri = replSet.getUri();
    stopMemoryServer = async () => {
      await replSet.stop();
      await rm(dbPath, { recursive: true, force: true }).catch(() => undefined);
    };
  }

  const client = new MongoClient(uri, {
    ignoreUndefined: true,
    retryWrites: true,
    serverSelectionTimeoutMS: 15_000,
  });
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  const supportsTransactions = await detectTransactionSupport(client);

  return {
    client,
    db,
    collections: buildCollections(db),
    supportsTransactions,
    close: async () => {
      await client.close();
      if (stopMemoryServer) await stopMemoryServer();
    },
  };
}

/**
 * Executa uma unidade de trabalho atômica. Em deployments sem replica
 * set as transações não existem; nesse caso a operação é executada sem
 * sessão e o chamador é responsável por ser idempotente (todas as
 * escritas financeiras usam `dedupeKey`/`idempotencyKey`).
 */
export async function withTransaction<T>(
  owner: { mongo: MongoContext },
  fn: (session: ClientSession | undefined) => Promise<T>,
): Promise<T> {
  const ctx = owner.mongo;
  if (!ctx.supportsTransactions) return fn(undefined);
  const session = ctx.client.startSession();
  try {
    let result!: T;
    await session.withTransaction(
      async () => {
        result = await fn(session);
      },
      { readConcern: { level: 'local' }, writeConcern: { w: 'majority' } },
    );
    return result;
  } finally {
    await session.endSession();
  }
}
