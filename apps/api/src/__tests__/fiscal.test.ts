import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { addDaysIso, businessDate, type FiscalNote, type PendingFiscalPayment } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';
import { buildPaymentReceiptDefinition } from '../pdf/payment-receipt.js';

/** Recibo de pagamento (PDF) e controle das notas de serviço emitidas fora do sistema. */
describe('recibos e controle fiscal', () => {
  let harness: TestHarness;
  let staff: string;
  let orgId: ObjectId;
  let accountId: string;
  const today = businessDate();

  type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  const call = (method: Method, url: string, payload?: unknown, cookie?: string) =>
    harness.app.inject({
      method,
      url,
      headers: cookie ? { cookie } : {},
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  beforeAll(async () => {
    harness = await createHarness();
    await seed(harness.ctx);
    const login = await call('POST', '/api/v1/auth/login', { email: harness.env.SEED_OWNER_EMAIL, password: harness.env.SEED_OWNER_PASSWORD });
    staff = sessionCookie(login.headers as Record<string, unknown>);
    orgId = (await harness.ctx.mongo.collections.memberships.findOne({ role: 'OWNER' }))!.organizationId;
    const acc = (await call('GET', '/api/v1/bank-accounts', undefined, staff)).json();
    accountId = ((acc.data ?? acc) as Array<{ id: string; isDefault: boolean }>).find((a) => a.isDefault)!.id;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  let seq = 0;
  /** Cria um motorista e uma conta a receber do tipo pedido já com um pagamento; devolve o id do pagamento. */
  const paid = async (kind: 'RENT' | 'OTHER' | 'FINE', amountCents = 60000, paidAt = today) => {
    seq += 1;
    const driver = await call('POST', '/api/v1/drivers', { fullName: `Pagador Fiscal ${seq}`, phone: `1199900${1000 + seq}` }, staff);
    const now = new Date();
    const description = kind === 'RENT' ? `Locação LOC-2026-90${seq}` : kind === 'OTHER' ? 'KM excedente' : `Multa AIT${seq}`;
    const receivableId = new ObjectId();
    await harness.ctx.mongo.collections.receivables.insertOne({
      _id: receivableId,
      organizationId: orgId,
      description,
      descriptionFold: description.toLowerCase(),
      rentalId: null,
      driverId: new ObjectId(driver.json().id),
      grossAmountCents: amountCents,
      paidAmountCents: 0,
      dueDate: addDaysIso(today, 3),
      paymentMethod: null,
      kind,
      installmentNo: null,
      expectedPeriod: null,
      status: 'OPEN',
      createdBy: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    } as never);
    const res = await call('POST', `/api/v1/receivables/${receivableId.toHexString()}/payments`, { amountCents, paidAt, method: 'PIX', bankAccountId: accountId }, staff);
    expect(res.statusCode).toBe(201);
    return { paymentId: res.json().payment.id as string, receivableId: receivableId.toHexString(), driverName: `Pagador Fiscal ${seq}` };
  };
  const note = (paymentId: string, over: Record<string, unknown> = {}) =>
    call('POST', '/api/v1/fiscal/notes', { paymentId, number: `NF-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, issuedOn: today, ...over }, staff);
  const pending = async (query = '') => (await call('GET', `/api/v1/fiscal/pending${query}`, undefined, staff)).json() as { data: PendingFiscalPayment[]; totalCents: number };

  it('exige sessão', async () => {
    expect((await call('GET', '/api/v1/fiscal/pending')).statusCode).toBe(401);
    expect((await call('GET', `/api/v1/payments/${new ObjectId().toHexString()}/receipt.pdf`)).statusCode).toBe(401);
    expect((await call('POST', '/api/v1/fiscal/notes', {})).statusCode).toBe(401);
  });

  it('o recibo é um PDF com número fixo REC-AAAA-NNN e as mesmas informações a cada emissão', async () => {
    const p = await paid('RENT', 60000);
    const a = await call('GET', `/api/v1/payments/${p.paymentId}/receipt.pdf`, undefined, staff);
    expect(a.statusCode).toBe(200);
    expect(a.headers['content-type']).toBe('application/pdf');
    expect(a.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const saved = (await harness.ctx.mongo.collections.payments.findOne({ _id: new ObjectId(p.paymentId) }))!;
    expect(saved.receiptDocNumber).toMatch(/^REC-\d{4}-\d{3,}$/);
    const second = await call('GET', `/api/v1/payments/${p.paymentId}/receipt.pdf`, undefined, staff);
    expect(second.statusCode).toBe(200);
    expect((await harness.ctx.mongo.collections.payments.findOne({ _id: new ObjectId(p.paymentId) }))!.receiptDocNumber).toBe(saved.receiptDocNumber);
    // Outro pagamento ganha outro número.
    const other = await paid('RENT', 30000);
    await call('GET', `/api/v1/payments/${other.paymentId}/receipt.pdf`, undefined, staff);
    expect((await harness.ctx.mongo.collections.payments.findOne({ _id: new ObjectId(other.paymentId) }))!.receiptDocNumber).not.toBe(saved.receiptDocNumber);
  });

  it('o recibo diz que não substitui a nota fiscal e mostra valor, data e forma de pagamento', () => {
    const def = buildPaymentReceiptDefinition(
      { receiptNumber: 'REC-2026-001', organization: { name: 'FF Veículos', legalId: '12.345.678/0001-90' }, payer: { fullName: 'Maria Souza', cpfMasked: 'final 901' }, description: 'Pagamento da locação - Contrato LOC-1', amountCents: 60000, paidAt: '2026-11-10', method: 'PIX', issuedAt: new Date('2026-11-11T12:00:00Z') },
      'data:image/png;base64,AAAA',
    );
    const text = JSON.stringify(def.content);
    expect(text).toContain('Não substitui a nota fiscal');
    expect(text).toContain('R$');
    expect(text).toContain('600,00');
    expect(text).toContain('10/11/2026');
    expect(text).toContain('PIX');
    expect(text).toContain('Maria Souza');
    expect(text).toContain('CNPJ 12.345.678/0001-90');
  });

  it('recibo de recebimento inexistente, estornado ou de compensação com caução é recusado', async () => {
    expect((await call('GET', `/api/v1/payments/${new ObjectId().toHexString()}/receipt.pdf`, undefined, staff)).statusCode).toBe(404);
    const p = await paid('RENT', 20000);
    const reversed = await call('POST', `/api/v1/receivables/${p.receivableId}/payments/${p.paymentId}/reverse`, { reason: 'Pagamento lançado errado' }, staff);
    expect(reversed.statusCode).toBe(200);
    expect((await call('GET', `/api/v1/payments/${p.paymentId}/receipt.pdf`, undefined, staff)).statusCode).toBe(409);
    const dep = await paid('RENT', 20000);
    await harness.ctx.mongo.collections.payments.updateOne({ _id: new ObjectId(dep.paymentId) }, { $set: { origin: 'DEPOSIT' } });
    expect((await call('GET', `/api/v1/payments/${dep.paymentId}/receipt.pdf`, undefined, staff)).statusCode).toBe(409);
  });

  it('pendentes: só aluguel e km excedente, sem multa, estornados nem caução; filtra por período', async () => {
    const rent = await paid('RENT', 61000, addDaysIso(today, -40));
    const extra = await paid('OTHER', 8000, addDaysIso(today, -40));
    const fine = await paid('FINE', 19523, addDaysIso(today, -40));
    const reversed = await paid('RENT', 5000, addDaysIso(today, -40));
    await call('POST', `/api/v1/receivables/${reversed.receivableId}/payments/${reversed.paymentId}/reverse`, { reason: 'Estorno de teste fiscal' }, staff);

    const from = addDaysIso(today, -41);
    const to = addDaysIso(today, -39);
    const res = await pending(`?from=${from}&to=${to}`);
    const ids = res.data.map((r) => r.paymentId);
    expect(ids).toContain(rent.paymentId);
    expect(ids).toContain(extra.paymentId);
    expect(ids).not.toContain(fine.paymentId);
    expect(ids).not.toContain(reversed.paymentId);
    const row = res.data.find((r) => r.paymentId === rent.paymentId)!;
    expect(row).toMatchObject({ amountCents: 61000, driverName: rent.driverName, method: 'PIX' });
    expect(row.description).toContain('Pagamento da locação');
    expect(res.totalCents).toBe(res.data.reduce((s, r) => s + r.amountCents, 0));
    // Fora do período não aparece.
    expect((await pending(`?from=${addDaysIso(today, -10)}`)).data.map((r) => r.paymentId)).not.toContain(rent.paymentId);
  });

  it('registrar a nota tira o recebimento dos pendentes e guarda o valor pago', async () => {
    const p = await paid('RENT', 61500);
    expect((await pending()).data.map((r) => r.paymentId)).toContain(p.paymentId);
    const res = await note(p.paymentId, { number: 'NFS-1001', url: 'https://nfe.prefeitura.exemplo/nota/1001', notes: 'Emitida no portal' });
    expect(res.statusCode).toBe(201);
    const created = res.json() as FiscalNote;
    expect(created).toMatchObject({ number: 'NFS-1001', amountCents: 61500, status: 'ISSUED', url: 'https://nfe.prefeitura.exemplo/nota/1001', driverName: p.driverName });
    expect((await pending()).data.map((r) => r.paymentId)).not.toContain(p.paymentId);
    const list = (await call('GET', '/api/v1/fiscal/notes', undefined, staff)).json().data as FiscalNote[];
    expect(list.find((n) => n.id === created.id)).toBeTruthy();
  });

  it('uma nota por recebimento e número único; multa não entra; data futura e link estranho são recusados', async () => {
    const p = await paid('RENT', 40000);
    expect((await note(p.paymentId, { number: 'NFS-2001' })).statusCode).toBe(201);
    expect((await note(p.paymentId, { number: 'NFS-2002' })).statusCode).toBe(409);
    const q = await paid('RENT', 40000);
    const dup = await note(q.paymentId, { number: 'NFS-2001' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.message).toContain('NFS-2001');
    const fine = await paid('FINE', 9000);
    expect((await note(fine.paymentId)).statusCode).toBe(422);
    expect((await note(q.paymentId, { issuedOn: addDaysIso(today, 2) })).statusCode).toBe(422);
    expect((await note(q.paymentId, { url: 'javascript:alert(1)' })).statusCode).toBe(422);
    expect((await note(q.paymentId, { number: '' })).statusCode).toBe(422);
    expect((await note(new ObjectId().toHexString())).statusCode).toBe(404);
  });

  it('cancelar a nota exige motivo, libera o recebimento para nova nota e o número cancelado pode ser reusado', async () => {
    const p = await paid('RENT', 35000);
    const created = (await note(p.paymentId, { number: 'NFS-3001' })).json() as FiscalNote;
    expect((await call('POST', `/api/v1/fiscal/notes/${created.id}/cancel`, { reason: '' }, staff)).statusCode).toBe(422);
    const canceled = await call('POST', `/api/v1/fiscal/notes/${created.id}/cancel`, { reason: 'Valor emitido errado' }, staff);
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json()).toMatchObject({ status: 'CANCELED', canceledReason: 'Valor emitido errado' });
    expect((await call('POST', `/api/v1/fiscal/notes/${created.id}/cancel`, { reason: 'De novo' }, staff)).statusCode).toBe(409);
    expect((await call('POST', `/api/v1/fiscal/notes/${new ObjectId().toHexString()}/cancel`, { reason: 'Qualquer' }, staff)).statusCode).toBe(404);
    // Volta para os pendentes e aceita nova nota (inclusive com o número reaproveitado).
    expect((await pending()).data.map((r) => r.paymentId)).toContain(p.paymentId);
    expect((await note(p.paymentId, { number: 'NFS-3001' })).statusCode).toBe(201);
  });

  it('exporta os pendentes em CSV para o contador, com data, motorista, descrição, forma e valor', async () => {
    const p = await paid('RENT', 61750);
    const res = await call('GET', '/api/v1/fiscal/pending.csv', undefined, staff);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const csv = res.body.replace(/^﻿/, '');
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('"Data do pagamento";"Motorista";"Descrição";"Forma de pagamento";"Valor"');
    expect(lines.some((l) => l.includes(p.driverName) && l.includes('"617,50"') && l.includes('"PIX"'))).toBe(true);
  });
});
