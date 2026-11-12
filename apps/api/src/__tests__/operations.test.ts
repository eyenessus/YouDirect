import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  addDaysIso,
  businessDate,
  defaultLoyaltySettings,
  fullMatrix,
  type DamagePrice,
  type DepositSettlementPreview,
  type DriverPortalAccessResult,
  type PortalInvoices,
  type RentalPaymentsView,
} from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { startFakeProviders, type FakeProviders } from '../testing/fake-providers.js';
import { seed } from '../database/seed.js';
import { hashPassword } from '../common/helpers.js';
import { recomputeLoyalty } from '../services/loyalty.js';
import { createSignatureProvider } from '../integrations/zapsign.js';
import { reconcileSignatures } from '../services/contract-signature.js';

/**
 * KM excedente automático, tabela de avarias, fechamento da caução,
 * fidelidade do motorista e contrato com assinatura digital (ZapSign falsa).
 */
const ZAP_SECRET = 'zapsign-webhook-secret';

describe('operação: km, avarias, caução, fidelidade e contrato', () => {
  let harness: TestHarness;
  let fake: FakeProviders;
  let staff: string;
  let orgId: ObjectId;
  const today = businessDate();

  type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  const call = (method: Method, url: string, payload?: unknown, cookie?: string, headers: Record<string, string> = {}) =>
    harness.app.inject({
      method,
      url,
      headers: { ...(cookie ? { cookie } : {}), ...headers },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  let seq = 0;
  const newRental = async (extra: Record<string, unknown> = {}, driverExtra: Record<string, unknown> = {}) => {
    seq += 1;
    const vehicle = await call('POST', '/api/v1/vehicles', { plate: `O${'ABCDEFGHIJ'[seq % 10]}P2D${10 + seq}`, brand: 'Fiat', model: `OPS${seq}`, mileageKm: 1 }, staff);
    const driver = await call('POST', '/api/v1/drivers', { fullName: `Motorista Ops ${seq}`, phone: `1144433${1000 + seq}`, ...driverExtra }, staff);
    expect(driver.statusCode).toBe(201);
    const rental = await call(
      'POST',
      '/api/v1/rentals',
      {
        vehicleId: vehicle.json().id,
        driverId: driver.json().id,
        rentalType: 'WEEKLY',
        periodicAmountCents: 60000,
        depositCents: 0,
        startDate: addDaysIso(today, -10),
        endDate: addDaysIso(today, 18),
        ...extra,
      },
      staff,
    );
    expect(rental.statusCode).toBe(201);
    return { vehicleId: vehicle.json().id as string, driverId: driver.json().id as string, rentalId: rental.json().id as string };
  };

  /** Vistoria enviada (com hodômetro) pronta para aprovar. */
  const submittedInspection = async (r: { vehicleId: string; driverId: string; rentalId: string }, odometerKm: number | null, submittedDaysAgo = 0) => {
    const _id = new ObjectId();
    const now = new Date();
    await harness.ctx.mongo.collections.inspections.insertOne({
      _id,
      organizationId: orgId,
      vehicleId: new ObjectId(r.vehicleId),
      rentalId: new ObjectId(r.rentalId),
      driverId: new ObjectId(r.driverId),
      responsibleName: 'Motorista',
      phone: '11900000000',
      email: null,
      scheduledAt: addDaysIso(today, -submittedDaysAgo),
      dueDate: addDaysIso(today, 2 - submittedDaysAgo),
      submittedAt: new Date(now.getTime() - submittedDaysAgo * 86_400_000),
      reviewedAt: null,
      reviewerId: null,
      status: 'SUBMITTED',
      odometerKm,
      photos: [],
      notes: null,
      requestTokenHash: null,
      requestExpiresAt: null,
      delivery: null,
      source: 'MANUAL',
      createdBy: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    return _id.toHexString();
  };
  const approve = (inspectionId: string) => call('POST', `/api/v1/inspections/${inspectionId}/review`, { decision: 'APPROVE' }, staff);
  const view = async (rentalId: string) => (await call('GET', `/api/v1/rentals/${rentalId}/payments`, undefined, staff)).json() as RentalPaymentsView;
  const memberCookie = async (email: string, permissions: Record<string, string[]>, role: 'MEMBER' | 'ADMIN' = 'MEMBER') => {
    const now = new Date();
    const userId = new ObjectId();
    await harness.ctx.mongo.collections.users.insertOne({
      _id: userId, name: email, emailLower: email, passwordHash: await hashPassword('Senha@12345'),
      phone: null, status: 'ACTIVE', browserNotificationsEnabled: false, lastLoginAt: null, createdAt: now, updatedAt: now,
    });
    await harness.ctx.mongo.collections.memberships.insertOne({
      _id: new ObjectId(), organizationId: orgId, userId, role, permissions: permissions as never, status: 'ACTIVE', createdAt: now, updatedAt: now,
    });
    return sessionCookie((await call('POST', '/api/v1/auth/login', { email, password: 'Senha@12345' })).headers as Record<string, unknown>);
  };
  const loginDriver = async (driverId: string) => {
    const access = (await call('POST', `/api/v1/drivers/${driverId}/portal-access`, undefined, staff)).json() as DriverPortalAccessResult;
    const res = await call('POST', '/api/v1/driver/login', { token: access.link.split('/motorista/entrar/')[1] });
    return sessionCookie(res.headers as Record<string, unknown>, 'yudirect_driver');
  };

  beforeAll(async () => {
    fake = await startFakeProviders();
    harness = await createHarness({ ZAPSIGN_API_TOKEN: 'zap-test', ZAPSIGN_API_URL: fake.url, ZAPSIGN_WEBHOOK_SECRET: ZAP_SECRET });
    await seed(harness.ctx);
    const login = await call('POST', '/api/v1/auth/login', { email: harness.env.SEED_OWNER_EMAIL, password: harness.env.SEED_OWNER_PASSWORD });
    staff = sessionCookie(login.headers as Record<string, unknown>);
    orgId = (await harness.ctx.mongo.collections.memberships.findOne({ role: 'OWNER' }))!.organizationId;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
    await fake?.close();
  });

  /* ------------------------------ KM ------------------------------ */
  it('aprovar vistoria com hodômetro lança o km excedente na aba Pagamentos', async () => {
    const r = await newRental();
    const policy = await call('PUT', `/api/v1/rentals/${r.rentalId}/km-policy`, { weeklyFranchiseKm: 1000, extraKmPriceCents: 50, startOdometerKm: 20000 }, staff);
    expect(policy.statusCode).toBe(200);

    // 10 dias => franquia 1429 km; rodou 2000 => 571 km × R$ 0,50
    const i1 = await submittedInspection(r, 22000);
    const res = await approve(i1);
    expect(res.statusCode).toBe(200);
    expect(res.json().extraKm).toEqual({ status: 'CHARGED', km: 571, amountCents: 28550 });
    const v = await view(r.rentalId);
    const extra = v.entries.filter((e) => e.category === 'EXTRA_KM');
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatchObject({ amountCents: 28550, status: 'PENDING' });

    // Nova leitura: só cobra a diferença.
    const i2 = await submittedInspection(r, 22100);
    expect((await approve(i2)).json().extraKm).toMatchObject({ status: 'CHARGED', km: 100, amountCents: 5000 });

    // Leitura menor (erro de digitação) não cobra.
    const i3 = await submittedInspection(r, 21000);
    expect((await approve(i3)).json().extraKm.status).toBe('ODOMETER_LOWER');

    const summary = (await call('GET', `/api/v1/rentals/${r.rentalId}/km-summary`, undefined, staff)).json();
    expect(summary).toMatchObject({ baselineOdometerKm: 20000, lastOdometerKm: 22100, drivenKm: 2100, chargedKm: 671, chargedCents: 33550 });

    // A Área do Motorista mostra o resumo de km.
    const driver = await loginDriver(r.driverId);
    const km = (await call('GET', '/api/v1/driver/km', undefined, driver)).json();
    expect(km.summary.chargedKm).toBe(671);
  });

  it('sem hodômetro de entrega a 1ª vistoria vira a base; sem política nada é cobrado', async () => {
    const r = await newRental();
    await call('PUT', `/api/v1/rentals/${r.rentalId}/km-policy`, { weeklyFranchiseKm: 1000, extraKmPriceCents: 50, startOdometerKm: null }, staff);
    expect((await approve(await submittedInspection(r, 50000))).json().extraKm.status).toBe('BASELINE');
    expect((await approve(await submittedInspection(r, 51000))).json().extraKm.status).toBe('NO_EXCESS');

    const free = await newRental();
    expect((await approve(await submittedInspection(free, 10000))).json().extraKm.status).toBe('BASELINE');
    expect((await approve(await submittedInspection(free, 90000))).json().extraKm.status).toBe('NO_POLICY');
    expect((await view(free.rentalId)).entries.filter((e) => e.category === 'EXTRA_KM')).toHaveLength(0);

    // Reprovar não processa km; vistoria sem hodômetro também não.
    const rej = await submittedInspection(r, 99999);
    expect((await call('POST', `/api/v1/inspections/${rej}/review`, { decision: 'REJECT' }, staff)).json().extraKm).toBeNull();
    expect((await approve(await submittedInspection(r, null))).json().extraKm.status).toBe('NOT_APPLICABLE');
  });

  /* ---------------------------- Avarias ---------------------------- */
  let damageRental: { vehicleId: string; driverId: string; rentalId: string };

  it('tabela padrão de avarias, cobrança na vistoria (uma por vez) e cancelamento', async () => {
    const prices = (await call('GET', '/api/v1/damage-prices', undefined, staff)).json().data as DamagePrice[];
    expect(prices.length).toBeGreaterThanOrEqual(15);
    const risco = prices.find((p) => p.name.startsWith('Risco leve'))!;
    const retrovisor = prices.find((p) => p.name === 'Retrovisor')!;

    damageRental = await newRental({ depositCents: 300000, depositPrepaid: true });
    const insp = await submittedInspection(damageRental, null);
    const body = { items: [{ damagePriceId: risco.id, quantity: 2 }, { damagePriceId: retrovisor.id, quantity: 1, note: 'lado esquerdo' }] };
    const res = await call('POST', `/api/v1/inspections/${insp}/damages`, body, staff);
    expect(res.statusCode).toBe(201);
    expect(res.json().totalCents).toBe(2 * risco.priceCents + retrovisor.priceCents);
    expect((await call('POST', `/api/v1/inspections/${insp}/damages`, body, staff)).statusCode).toBe(409);

    const rec = await harness.ctx.mongo.collections.receivables.findOne({ _id: new ObjectId(res.json().receivable.id) });
    expect(rec).toMatchObject({ kind: 'DAMAGE', grossAmountCents: res.json().totalCents });
    // Avaria não aparece na aba Pagamentos da locação, mas aparece para o motorista.
    expect((await view(damageRental.rentalId)).entries.some((e) => e.amountCents === res.json().totalCents)).toBe(false);
    const driver = await loginDriver(damageRental.driverId);
    const inv = (await call('GET', '/api/v1/driver/invoices', undefined, driver)).json() as PortalInvoices;
    expect(inv.invoices.some((i) => i.kind === 'DAMAGE')).toBe(true);

    expect((await call('DELETE', `/api/v1/inspections/${insp}/damages`, undefined, staff)).statusCode).toBe(200);
    expect((await harness.ctx.mongo.collections.receivables.findOne({ _id: rec!._id }))?.status).toBe('CANCELED');
    // Refaz com outra composição.
    const redo = await call('POST', `/api/v1/inspections/${insp}/damages`, { items: [{ damagePriceId: retrovisor.id, quantity: 1 }] }, staff);
    expect(redo.statusCode).toBe(201);
    expect((await call('GET', `/api/v1/inspections/${insp}/damages`, undefined, staff)).json().data).toHaveLength(2);
  });

  it('avarias: preço editável, item inativo recusado e permissão exigida', async () => {
    const created = await call('POST', '/api/v1/damage-prices', { name: 'Tapete', category: 'Interior', priceCents: 8000 }, staff);
    expect(created.statusCode).toBe(201);
    expect((await call('POST', '/api/v1/damage-prices', { name: 'Tapete', category: 'Interior', priceCents: 8000 }, staff)).statusCode).toBe(409);
    await call('PATCH', `/api/v1/damage-prices/${created.json().id}`, { active: false }, staff);
    const r = await newRental();
    const insp = await submittedInspection(r, null);
    expect((await call('POST', `/api/v1/inspections/${insp}/damages`, { items: [{ damagePriceId: created.json().id }] }, staff)).statusCode).toBe(400);

    const viewer = await memberCookie('so-ver-vistoria@exemplo.test', { inspections: ['read'] });
    expect((await call('GET', '/api/v1/damage-prices', undefined, viewer)).statusCode).toBe(200);
    expect((await call('POST', `/api/v1/inspections/${insp}/damages`, { items: [{ damagePriceId: created.json().id }] }, viewer)).statusCode).toBe(403);
    expect((await call('POST', '/api/v1/damage-prices', { name: 'X', category: 'Y', priceCents: 1 }, viewer)).statusCode).toBe(403);
  });

  /* ----------------------------- Caução ----------------------------- */
  it('caução: só fecha com a locação encerrada; compensa dívidas e devolve o resto', async () => {
    const r = damageRental;
    const blocked = (await call('GET', `/api/v1/rentals/${r.rentalId}/deposit-settlement`, undefined, staff)).json() as DepositSettlementPreview;
    expect(blocked).toMatchObject({ depositHeldCents: 300000, canSettle: false });
    expect(blocked.blockedReason).toContain('Encerre');
    expect((await call('POST', `/api/v1/rentals/${r.rentalId}/deposit-settlement`, {}, staff)).statusCode).toBe(409);

    expect((await call('POST', `/api/v1/rentals/${r.rentalId}/close`, { endDate: today }, staff)).statusCode).toBe(200);
    const preview = (await call('GET', `/api/v1/rentals/${r.rentalId}/deposit-settlement`, undefined, staff)).json() as DepositSettlementPreview;
    expect(preview.canSettle).toBe(true);
    const debt = preview.debts.reduce((a, d) => a + d.remainingCents, 0);
    expect(debt).toBeGreaterThan(0);
    expect(preview.appliedCents).toBe(Math.min(debt, 300000));
    expect(preview.refundCents).toBe(300000 - preview.appliedCents);

    const month = Number(today.slice(5, 7));
    const year = Number(today.slice(0, 4));
    const revenue = async () => (await call('GET', `/api/v1/finance/dashboard?month=${month}&year=${year}`, undefined, staff)).json().revenueCents as number;
    const balance = async () => {
      const acc = (await call('GET', '/api/v1/bank-accounts', undefined, staff)).json();
      return ((acc.data ?? acc) as Array<{ isDefault: boolean; currentBalanceCents: number }>).find((a) => a.isDefault)!.currentBalanceCents;
    };
    const [rev0, bal0] = [await revenue(), await balance()];

    const res = await call('POST', `/api/v1/rentals/${r.rentalId}/deposit-settlement`, { notes: 'Fechamento normal' }, staff);
    expect(res.statusCode).toBe(200);
    expect(res.json().settled).toMatchObject({ appliedCents: preview.appliedCents, refundCents: preview.refundCents });
    // Compensação vira receita sem entrar de novo no banco; a devolução sai do banco.
    expect(await revenue()).toBe(rev0 + preview.appliedCents);
    expect(await balance()).toBe(bal0 - preview.refundCents);
    const open = await harness.ctx.mongo.collections.receivables
      .find({ rentalId: new ObjectId(r.rentalId), status: { $nin: ['PAID', 'CANCELED'] } })
      .toArray();
    expect(open.every((x) => x.paidAmountCents < x.grossAmountCents)).toBe(true);
    if (preview.refundCents > 0) expect(open).toHaveLength(0);

    expect((await call('POST', `/api/v1/rentals/${r.rentalId}/deposit-settlement`, {}, staff)).statusCode).toBe(409);
  });

  it('caução sem lançamento no extrato não pode ser fechada; permissão exigida', async () => {
    const r = await newRental({ depositCents: 100000, depositPrepaid: false });
    await call('POST', `/api/v1/rentals/${r.rentalId}/close`, { endDate: today }, staff);
    const p = (await call('GET', `/api/v1/rentals/${r.rentalId}/deposit-settlement`, undefined, staff)).json() as DepositSettlementPreview;
    expect(p).toMatchObject({ depositHeldCents: 0, canSettle: false });
    const reader = await memberCookie('so-financeiro-leitura@exemplo.test', { finance: ['read'] });
    expect((await call('GET', `/api/v1/rentals/${r.rentalId}/deposit-settlement`, undefined, reader)).statusCode).toBe(200);
    expect((await call('POST', `/api/v1/rentals/${r.rentalId}/deposit-settlement`, {}, reader)).statusCode).toBe(403);
  });

  /* --------------------------- Fidelidade --------------------------- */
  it('fidelidade: status por motorista, job grava o nível e portal mostra', async () => {
    const r = await newRental();
    const status = (await call('GET', `/api/v1/drivers/${r.driverId}/loyalty`, undefined, staff)).json();
    expect(status.enabled).toBe(true);
    expect(status.level.code).toBe('INICIAL');
    expect(status.criteria.map((c: { key: string }) => c.key)).toEqual(['TENURE', 'PAYMENTS', 'INSPECTIONS', 'FINES', 'CLAIMS']);
    // Semana 1 já venceu sem pagamento: penaliza.
    expect(status.criteria.find((c: { key: string }) => c.key === 'PAYMENTS').points).toBeLessThan(0);

    const updated = await recomputeLoyalty(harness.ctx, orgId, today);
    expect(updated).toBeGreaterThan(0);
    const doc = await harness.ctx.mongo.collections.drivers.findOne({ _id: new ObjectId(r.driverId) });
    expect(doc?.loyalty?.levelCode).toBe('INICIAL');

    const driver = await loginDriver(r.driverId);
    const mine = (await call('GET', '/api/v1/driver/loyalty', undefined, driver)).json();
    expect(mine.level.name).toBe('Inicial');
    expect(mine.nextLevel.name).toBe('Básico');
  });

  it('fidelidade: configuração validada e restrita a dono/admin; subir de nível avisa a equipe', async () => {
    const bad = { ...defaultLoyaltySettings, levels: [{ ...defaultLoyaltySettings.levels[0]!, minScore: 10 }, defaultLoyaltySettings.levels[1]!] };
    expect((await call('PUT', '/api/v1/loyalty/settings', bad, staff)).statusCode).toBe(422);
    const member = await memberCookie('membro-fidelidade@exemplo.test', fullMatrix() as Record<string, string[]>);
    expect((await call('PUT', '/api/v1/loyalty/settings', defaultLoyaltySettings, member)).statusCode).toBe(403);

    // Um nível único a partir de 0 e outro baixo: o seed (motoristas antigos) sobe e a equipe é avisada.
    const easy = {
      enabled: true,
      levels: [
        { code: 'A', name: 'Bronze', minScore: 0, weeklyDiscountPercent: 0, benefits: [] },
        { code: 'B', name: 'Prata', minScore: 1, weeklyDiscountPercent: 3, benefits: ['3% de desconto'] },
      ],
    };
    await harness.ctx.mongo.collections.drivers.updateMany({ organizationId: orgId }, { $set: { 'loyalty.levelCode': 'A', 'loyalty.score': 0, 'loyalty.computedAt': new Date() } });
    expect((await call('PUT', '/api/v1/loyalty/settings', easy, staff)).statusCode).toBe(200);
    await recomputeLoyalty(harness.ctx, orgId, today);
    const up = await harness.ctx.mongo.collections.notifications.countDocuments({ organizationId: orgId, title: 'Motorista subiu de nível' });
    expect(up).toBeGreaterThan(0);
    await call('PUT', '/api/v1/loyalty/settings', defaultLoyaltySettings, staff);
  });

  /* ---------------------- Contrato e assinatura ---------------------- */
  it('contrato em PDF é gerado a partir da locação', async () => {
    const r = await newRental();
    const res = await call('GET', `/api/v1/rentals/${r.rentalId}/contract.pdf`, undefined, staff);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('assinatura digital com selfie + CNH validada no governo (CPF), webhook e PDF assinado anexado', async () => {
    const r = await newRental({}, { cpf: '418.273.650-80' });
    const res = await call('POST', `/api/v1/rentals/${r.rentalId}/signature`, undefined, staff);
    expect(res.statusCode).toBe(201);
    const sig = res.json();
    expect(sig).toMatchObject({ status: 'SENT', provider: 'ZAPSIGN', identity: { selfie: true, document: true, validationType: 'face-match-and-datavalid' } });
    expect(sig.signUrl).toMatch(/^https:\/\/app\.zapsign\.com\.br\/verificar\//);

    const doc = [...fake.docs.values()].find((d) => d.externalId === r.rentalId)!;
    expect(doc.signer).toMatchObject({ require_selfie_photo: true, require_document_photo: true, selfie_validation_type: 'face-match-and-datavalid', cpf: '41827365080', phone_country: '55' });

    // Reenviar reaproveita o mesmo documento.
    expect((await call('POST', `/api/v1/rentals/${r.rentalId}/signature`, undefined, staff)).json().id).toBe(sig.id);

    // Portal mostra o link de assinatura.
    const driver = await loginDriver(r.driverId);
    expect((await call('GET', '/api/v1/driver/contracts', undefined, driver)).json().data[0]).toMatchObject({ status: 'SENT', signUrl: sig.signUrl });

    // Webhook: sem o segredo é recusado; antes de assinar continua pendente.
    expect((await call('POST', '/api/v1/webhooks/zapsign', { token: doc.token }, undefined, { authorization: 'Bearer errado' })).statusCode).toBe(403);
    const auth = { authorization: `Bearer ${ZAP_SECRET}` };
    expect((await call('POST', '/api/v1/webhooks/zapsign', { token: doc.token, event_type: 'doc_signed' }, undefined, auth)).json().status).toBe('SENT');

    fake.sign(doc.token);
    const signed = await call('POST', '/api/v1/webhooks/zapsign', { token: doc.token, event_type: 'doc_signed' }, undefined, auth);
    expect(signed.json().status).toBe('SIGNED');
    const rental = await harness.ctx.mongo.collections.rentals.findOne({ _id: new ObjectId(r.rentalId) });
    expect(rental?.contractFileId).toBeTruthy();
    const after = (await call('GET', `/api/v1/rentals/${r.rentalId}/signature`, undefined, staff)).json();
    expect(after.signature).toMatchObject({ status: 'SIGNED' });
    expect(after.signature.signedFile.url).toContain('/files/');
    expect((await call('POST', `/api/v1/rentals/${r.rentalId}/signature`, undefined, staff)).statusCode).toBe(409);
    expect(await harness.ctx.mongo.collections.notifications.countDocuments({ title: 'Contrato assinado' })).toBe(1);
  });

  it('sem CPF a selfie usa prova de vida; cancelamento e conciliação; provedor desligado = 503', async () => {
    const r = await newRental();
    const sig = (await call('POST', `/api/v1/rentals/${r.rentalId}/signature`, undefined, staff)).json();
    expect(sig.identity.validationType).toBe('liveness-NXCD');
    expect((await call('DELETE', `/api/v1/rentals/${r.rentalId}/signature`, undefined, staff)).statusCode).toBe(200);
    expect((await call('DELETE', `/api/v1/rentals/${r.rentalId}/signature`, undefined, staff)).statusCode).toBe(404);

    const r2 = await newRental();
    await call('POST', `/api/v1/rentals/${r2.rentalId}/signature`, undefined, staff);
    const doc = [...fake.docs.values()].find((d) => d.externalId === r2.rentalId)!;
    fake.sign(doc.token);
    expect(await reconcileSignatures(harness.ctx, orgId)).toBeGreaterThanOrEqual(1);
    expect((await call('GET', `/api/v1/rentals/${r2.rentalId}/signature`, undefined, staff)).json().signature.status).toBe('SIGNED');

    const original = harness.ctx.integrations.signature;
    harness.ctx.integrations.signature = createSignatureProvider({ ...harness.env, ZAPSIGN_API_TOKEN: undefined });
    try {
      const r3 = await newRental();
      const off = await call('POST', `/api/v1/rentals/${r3.rentalId}/signature`, undefined, staff);
      expect(off.statusCode).toBe(503);
      // O PDF continua disponível para assinatura manual.
      expect((await call('GET', `/api/v1/rentals/${r3.rentalId}/contract.pdf`, undefined, staff)).statusCode).toBe(200);
    } finally {
      harness.ctx.integrations.signature = original;
    }
  });
});
