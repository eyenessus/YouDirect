import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { fullMatrix } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { hashPassword } from '../common/helpers.js';

interface Org {
  organizationId: ObjectId;
  cookie: string;
  email: string;
}

describe('fluxos funcionais da API', () => {
  let harness: TestHarness;
  let alpha: Org;
  let beta: Org;
  let restricted: string;

  const createOrg = async (name: string, email: string, password: string): Promise<Org> => {
    const ctx = harness.ctx;
    const now = new Date();
    const organizationId = new ObjectId();
    await ctx.mongo.collections.organizations.insertOne({
      _id: organizationId,
      name,
      legalId: null,
      timezone: 'America/Sao_Paulo',
      currency: 'BRL',
      settings: { freeSeats: 3, extraSeatPriceCents: 990 },
      createdAt: now,
      updatedAt: now,
    });
    const userId = new ObjectId();
    await ctx.mongo.collections.users.insertOne({
      _id: userId,
      name,
      emailLower: email,
      passwordHash: await hashPassword(password),
      phone: null,
      status: 'ACTIVE',
      browserNotificationsEnabled: false,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.mongo.collections.memberships.insertOne({
      _id: new ObjectId(),
      organizationId,
      userId,
      role: 'OWNER',
      permissions: fullMatrix(),
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    });
    expect(login.statusCode).toBe(200);
    return { organizationId, cookie: sessionCookie(login.headers as Record<string, unknown>), email };
  };

  beforeAll(async () => {
    harness = await createHarness();
    alpha = await createOrg('Alpha Locadora', 'alpha@exemplo.test', 'Alpha@123456');
    beta = await createOrg('Beta Locadora', 'beta@exemplo.test', 'Beta@123456');

    // Colaborador sem o módulo Financeiro (T18).
    const ctx = harness.ctx;
    const now = new Date();
    const userId = new ObjectId();
    await ctx.mongo.collections.users.insertOne({
      _id: userId,
      name: 'Colaborador Restrito',
      emailLower: 'restrito@exemplo.test',
      passwordHash: await hashPassword('Restrito@123'),
      phone: null,
      status: 'ACTIVE',
      browserNotificationsEnabled: false,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.mongo.collections.memberships.insertOne({
      _id: new ObjectId(),
      organizationId: alpha.organizationId,
      userId,
      role: 'MEMBER',
      permissions: { vehicles: ['read'], dashboard: ['read'] },
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'restrito@exemplo.test', password: 'Restrito@123' },
    });
    restricted = sessionCookie(login.headers as Record<string, unknown>);
  }, 600_000);

  afterAll(async () => {
    await harness?.close();
  });

  const req = (cookie: string) => ({
    get: (url: string) => harness.app.inject({ method: 'GET', url, headers: { cookie } }),
    post: (url: string, payload?: unknown, headers: Record<string, string> = {}) =>
      harness.app.inject({ method: 'POST', url, headers: { cookie, ...headers }, payload: payload as never }),
    patch: (url: string, payload?: unknown) =>
      harness.app.inject({ method: 'PATCH', url, headers: { cookie }, payload: payload as never }),
    put: (url: string, payload?: unknown) =>
      harness.app.inject({ method: 'PUT', url, headers: { cookie }, payload: payload as never }),
    del: (url: string) => harness.app.inject({ method: 'DELETE', url, headers: { cookie } }),
  });

  /* ------------------------------- T01 ----------------------------- */
  describe('T01 — autenticação, sessão e isolamento entre organizações', () => {
    it('rejeita credenciais inválidas sem revelar se o e-mail existe', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: alpha.email, password: 'senha-errada' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toBe('E-mail ou senha inválidos.');

      const unknown = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'ninguem@exemplo.test', password: 'qualquer' },
      });
      expect(unknown.statusCode).toBe(401);
      expect(unknown.json().error.message).toBe('E-mail ou senha inválidos.');
    });

    it('bloqueia rotas privadas sem sessão', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/v1/vehicles' });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    });

    it('não permite acessar registros de outra organização', async () => {
      const created = await req(alpha.cookie).post('/api/v1/vehicles', {
        plate: 'AAA1A11',
        brand: 'VW',
        model: 'GOL',
        mileageKm: 1000,
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id;

      const own = await req(alpha.cookie).get(`/api/v1/vehicles/${id}`);
      expect(own.statusCode).toBe(200);

      const other = await req(beta.cookie).get(`/api/v1/vehicles/${id}`);
      expect(other.statusCode).toBe(404);

      const list = await req(beta.cookie).get('/api/v1/vehicles');
      expect(list.json().data).toHaveLength(0);
    });

    it('logout revoga a sessão', async () => {
      const temp = await createOrg('Gama Locadora', 'gama@exemplo.test', 'Gama@123456');
      const before = await req(temp.cookie).get('/api/v1/auth/me');
      expect(before.statusCode).toBe(200);
      await req(temp.cookie).post('/api/v1/auth/logout');
      const after = await req(temp.cookie).get('/api/v1/auth/me');
      expect(after.statusCode).toBe(401);
    });
  });

  /* ------------------------------- T18 ----------------------------- */
  describe('T18 — RBAC por módulo e ação', () => {
    it('colaborador sem o módulo Financeiro recebe 403', async () => {
      const res = await req(restricted).get('/api/v1/payables');
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });

    it('colaborador com leitura de Veículos não pode criar nem excluir', async () => {
      const read = await req(restricted).get('/api/v1/vehicles');
      expect(read.statusCode).toBe(200);
      const create = await req(restricted).post('/api/v1/vehicles', {
        plate: 'BBB2B22',
        brand: 'FIAT',
        model: 'ARGO',
      });
      expect(create.statusCode).toBe(403);
    });

    it('colaborador não acessa a administração de colaboradores', async () => {
      const res = await req(restricted).get('/api/v1/employees');
      expect(res.statusCode).toBe(403);
    });
  });

  /* --------------------------- T04 / T06 --------------------------- */
  describe('T04/T06 — cadastros com validação e integridade', () => {
    it('normaliza a placa e impede duplicidade na mesma organização', async () => {
      const first = await req(alpha.cookie).post('/api/v1/vehicles', {
        plate: ' ccc3c33 ',
        brand: 'FIAT',
        model: 'MOBI',
        mileageKm: 0,
      });
      expect(first.statusCode).toBe(201);
      expect(first.json().plate).toBe('CCC3C33');

      const duplicated = await req(alpha.cookie).post('/api/v1/vehicles', {
        plate: 'CCC3C33',
        brand: 'FIAT',
        model: 'MOBI',
      });
      expect(duplicated.statusCode).toBe(409);
      expect(duplicated.json().error.message).toContain('placa');

      // A mesma placa é permitida em OUTRA organização.
      const otherOrg = await req(beta.cookie).post('/api/v1/vehicles', {
        plate: 'CCC3C33',
        brand: 'FIAT',
        model: 'MOBI',
      });
      expect(otherOrg.statusCode).toBe(201);
    });

    it('rejeita placa fora do padrão e hodômetro negativo', async () => {
      const bad = await req(alpha.cookie).post('/api/v1/vehicles', {
        plate: 'XX123',
        brand: 'VW',
        model: 'GOL',
      });
      expect(bad.statusCode).toBe(422);
      const negative = await req(alpha.cookie).post('/api/v1/vehicles', {
        plate: 'DDD4D44',
        brand: 'VW',
        model: 'GOL',
        mileageKm: -5,
      });
      expect(negative.statusCode).toBe(422);
    });

    it('rejeita CPF inválido e impede CPF duplicado', async () => {
      const invalid = await req(alpha.cookie).post('/api/v1/drivers', {
        fullName: 'Teste Inválido',
        cpf: '111.111.111-11',
        phone: '11999990000',
      });
      expect(invalid.statusCode).toBe(422);

      const ok = await req(alpha.cookie).post('/api/v1/drivers', {
        fullName: 'Motorista Um',
        cpf: '529.982.247-25',
        phone: '11999990001',
      });
      expect(ok.statusCode).toBe(201);
      expect(ok.json().cpf).toBe('52998224725');

      const duplicated = await req(alpha.cookie).post('/api/v1/drivers', {
        fullName: 'Motorista Dois',
        cpf: '52998224725',
        phone: '11999990002',
      });
      expect(duplicated.statusCode).toBe(409);
    });

    it('sinaliza CNH vencida no detalhe do motorista', async () => {
      const created = await req(alpha.cookie).post('/api/v1/drivers', {
        fullName: 'Motorista CNH Vencida',
        phone: '11999990003',
        cnhNumber: '12345678901',
        cnhCategory: 'b',
        cnhExpiresAt: '2020-01-01',
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().cnhExpired).toBe(true);
      expect(created.json().cnhCategory).toBe('B');
    });

    it('informa indisponibilidade da consulta de CEP em vez de inventar endereço', async () => {
      const res = await req(alpha.cookie).get('/api/v1/postal-codes/01310100');
      expect(res.statusCode).toBe(200);
      expect(res.json().available).toBe(false);
      expect(res.json().address).toBeNull();
      expect(res.json().message).toContain('não configurada');
    });

    it('não simula consulta de multas sem provedor', async () => {
      const vehicles = await req(alpha.cookie).get('/api/v1/vehicles');
      const id = vehicles.json().data[0].id;
      const res = await req(alpha.cookie).get(`/api/v1/vehicles/${id}/traffic-fines`);
      expect(res.statusCode).toBe(200);
      expect(res.json().available).toBe(false);
      expect(res.json().fines).toEqual([]);
      expect(res.json().message).toContain('não configurada');
    });
  });

  /* ------------------------------- T05 ----------------------------- */
  describe('T05 — importação de veículos por planilha', () => {
    const csv = [
      'placa;marca;modelo;ano;cor;hodometro;uf_emplacamento;valor_compra',
      'EEE5E55;VW;POLO;2024;PRATA;1200;SP;68.000,00',
      'FFF6F66;FIAT;CRONOS;2023;PRETO;9000;SP;72.500,00',
      'XX1;FIAT;QUEBRADO;2023;PRETO;0;SP;0',
      'EEE5E55;VW;REPETIDO;2024;PRATA;1200;SP;0',
    ].join('\n');

    const multipart = (content: string, filename = 'veiculos.csv') => {
      const boundary = '----yudirecttest';
      const body =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: text/csv\r\n\r\n' +
        `${content}\r\n` +
        `--${boundary}--\r\n`;
      return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
    };

    it('mostra erros por linha, duplicatas e permite confirmar só as válidas', async () => {
      const { body, headers } = multipart(csv);
      const preview = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/vehicles/import/preview',
        headers: { cookie: alpha.cookie, ...headers },
        payload: body,
      });
      expect(preview.statusCode).toBe(200);
      const data = preview.json();
      expect(data.totalRows).toBe(4);
      expect(data.validRows).toBe(2);
      expect(data.invalidRows).toBe(2);
      expect(data.limit).toBe(200);

      const broken = data.rows.find((r: { data: { model: string } }) => r.data.model === 'QUEBRADO');
      expect(broken.errors.join(' ')).toContain('Placa');
      const repeated = data.rows.find((r: { data: { model: string } }) => r.data.model === 'REPETIDO');
      expect(repeated.duplicateInFile).toBe(true);

      const valid = data.rows
        .filter((r: { errors: string[] }) => r.errors.length === 0)
        .map((r: { line: number }) => r.line);
      const commit = await req(alpha.cookie).post('/api/v1/vehicles/import/commit', {
        token: data.token,
        lines: valid,
      });
      expect(commit.statusCode).toBe(200);
      expect(commit.json().created).toBe(2);

      const list = await req(alpha.cookie).get('/api/v1/vehicles?q=POLO');
      expect(list.json().data[0].plate).toBe('EEE5E55');
      expect(list.json().data[0].purchaseAmountCents).toBe(6800000);
    });

    it('rejeita planilha acima do limite de 200 veículos', async () => {
      const rows = ['placa;marca;modelo'];
      for (let i = 0; i < 201; i++) rows.push(`ABC${String(i).padStart(4, '0')};VW;GOL`);
      const { body, headers } = multipart(rows.join('\n'));
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/vehicles/import/preview',
        headers: { cookie: alpha.cookie, ...headers },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('200');
    });

    it('entrega a planilha modelo em XLSX', async () => {
      const res = await req(alpha.cookie).get('/api/v1/vehicles/import/template');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('spreadsheetml');
      expect(res.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
    });
  });

  /* ------------------------------- T07 ----------------------------- */
  describe('T07 — locações, conflitos e disponibilidade do veículo', () => {
    let vehicleId: string;
    let driverId: string;
    let rentalId: string;

    it('cria a locação, marca o veículo como locado e gera a conta a receber', async () => {
      const vehicle = await req(alpha.cookie).post('/api/v1/vehicles', {
        plate: 'GGG7G77',
        brand: 'VW',
        model: 'VIRTUS',
        mileageKm: 500,
      });
      vehicleId = vehicle.json().id;
      const driver = await req(alpha.cookie).post('/api/v1/drivers', {
        fullName: 'Locatário Teste',
        phone: '11999990010',
      });
      driverId = driver.json().id;

      const rental = await req(alpha.cookie).post('/api/v1/rentals', {
        vehicleId,
        driverId,
        startDate: '2026-11-01',
        endDate: '2026-12-01',
        rentalType: 'MONTHLY',
        periodicAmountCents: 120000,
        depositCents: 50000,
      });
      expect(rental.statusCode).toBe(201);
      rentalId = rental.json().id;
      expect(rental.json().rentalNumber).toMatch(/^LOC-2026-\d{4}$/);

      const vehicleAfter = await req(alpha.cookie).get(`/api/v1/vehicles/${vehicleId}`);
      expect(vehicleAfter.json().status).toBe('RENTED');

      const receivables = await req(alpha.cookie).get('/api/v1/receivables?limit=50');
      const created = (receivables.json().data as Array<{ rental: { id: string } | null }>).find(
        (r) => r.rental?.id === rentalId,
      );
      expect(created).toBeTruthy();
    });

    it('impede locação sobreposta para o mesmo veículo', async () => {
      const conflict = await req(alpha.cookie).post('/api/v1/rentals', {
        vehicleId,
        driverId,
        startDate: '2026-11-15',
        rentalType: 'MONTHLY',
        periodicAmountCents: 100000,
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error.message).toContain('locação ativa');
    });

    it('rejeita término anterior ao início', async () => {
      const res = await req(alpha.cookie).patch(`/api/v1/rentals/${rentalId}`, {
        endDate: '2026-10-01',
      });
      expect(res.statusCode).toBe(409);
    });

    it('encerrar a locação devolve o veículo para disponível', async () => {
      const close = await req(alpha.cookie).post(`/api/v1/rentals/${rentalId}/close`, {
        endDate: '2026-11-20',
      });
      expect(close.statusCode).toBe(200);
      const vehicleAfter = await req(alpha.cookie).get(`/api/v1/vehicles/${vehicleId}`);
      expect(vehicleAfter.json().status).toBe('AVAILABLE');
    });

    it('não exclui veículo com locação ativa', async () => {
      const vehicle = await req(alpha.cookie).post('/api/v1/vehicles', {
        plate: 'HHH8H88',
        brand: 'FIAT',
        model: 'PULSE',
      });
      const v = vehicle.json().id;
      await req(alpha.cookie).post('/api/v1/rentals', {
        vehicleId: v,
        driverId,
        startDate: '2026-11-01',
        rentalType: 'WEEKLY',
        periodicAmountCents: 70000,
      });
      const res = await req(alpha.cookie).del(`/api/v1/vehicles/${v}`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toContain('locação ativa');
    });
  });

  /* --------------------------- T08 / T09 --------------------------- */
  describe('T08/T09 — manutenção: somas, conclusão e lançamento único', () => {
    let vehicleId: string;
    let accountId: string;
    let orderId: string;

    it('cria conta bancária padrão', async () => {
      const res = await req(alpha.cookie).post('/api/v1/bank-accounts', {
        name: 'Conta Principal',
        type: 'CHECKING',
        initialBalanceCents: 0,
        initialBalanceDate: '2026-01-01',
        isDefault: true,
      });
      expect(res.statusCode).toBe(201);
      accountId = res.json().id;
    });

    it('calcula totalPeças = Σ(qtd × unitário) e total = mão de obra + peças', async () => {
      const vehicle = await req(alpha.cookie).post('/api/v1/vehicles', {
        plate: 'JJJ9J99',
        brand: 'VW',
        model: 'SAVEIRO',
        mileageKm: 10000,
      });
      vehicleId = vehicle.json().id;

      const res = await req(alpha.cookie).post(`/api/v1/vehicles/${vehicleId}/maintenance`, {
        type: 'CORRECTIVE',
        description: 'TROCA DE DISCO DE FREIO E PASTILHA',
        performedAt: '2026-11-05',
        laborCostCents: 25000,
        mileageKm: 10500,
        paymentMethod: 'CASH',
        bankAccountId: accountId,
        status: 'COMPLETED',
        items: [
          { name: 'DISCO DE FREIO', quantity: 2, unitCostCents: 18485, supplier: 'MERCADO CAR' },
        ],
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      orderId = body.id;
      expect(body.partsCostCents).toBe(36970);
      expect(body.totalCents).toBe(61970);
      expect(body.items[0].subtotalCents).toBe(36970);
      expect(body.ledgerPosted).toBe(true);
    });

    it('atualiza o hodômetro do veículo quando a OS informa KM maior', async () => {
      const vehicle = await req(alpha.cookie).get(`/api/v1/vehicles/${vehicleId}`);
      expect(vehicle.json().mileageKm).toBe(10500);
    });

    it('lança a saída bancária exatamente uma vez ao concluir novamente', async () => {
      const first = await req(alpha.cookie).post(`/api/v1/maintenance/${orderId}/complete`);
      expect(first.statusCode).toBe(200);
      const statement = await req(alpha.cookie).get(
        `/api/v1/bank-accounts/${accountId}/statement?from=2026-11-01&to=2026-11-30`,
      );
      const maintenanceRows = (statement.json().transactions as Array<{ origin: string }>).filter(
        (t) => t.origin === 'MAINTENANCE',
      );
      expect(maintenanceRows).toHaveLength(1);
      expect(statement.json().outflowCents).toBe(61970);
    });

    it('cancelar a OS estorna o lançamento e remove o custo dos totais', async () => {
      const cancel = await req(alpha.cookie).post(`/api/v1/maintenance/${orderId}/cancel`);
      expect(cancel.statusCode).toBe(200);

      const history = await req(alpha.cookie).get(`/api/v1/vehicles/${vehicleId}/maintenance`);
      expect(history.json().summary.canceledCount).toBe(1);
      expect(history.json().summary.totalCents).toBe(0);

      const statement = await req(alpha.cookie).get(
        `/api/v1/bank-accounts/${accountId}/statement?from=2026-11-01&to=2026-11-30`,
      );
      expect(statement.json().outflowCents).toBe(61970);
      expect(statement.json().inflowCents).toBe(61970); // estorno
      expect(statement.json().closingBalanceCents).toBe(statement.json().openingBalanceCents);
    });

    it('o PDF exclui o custo das ordens canceladas dos totais', async () => {
      const res = await req(alpha.cookie).get(
        `/api/v1/vehicles/${vehicleId}/maintenance/report.pdf`,
      );
      expect(res.statusCode).toBe(200);
      const { extractPlainText } = await import('../pdf/extract.js');
      const text = extractPlainText(res.rawPayload).replace(/\u00a0/g, ' ');
      expect(text).toContain('Cancelada');
      expect(text).toContain('R$ 0,00 R$ 0,00 R$ 0,00 R$ 0,00');
    }, 60_000);
  });

  /* --------------------------- T12 / T14 --------------------------- */
  describe('T12/T14 — contas bancárias, pagamentos e idempotência', () => {
    let accountId: string;
    let secondAccountId: string;
    let payableId: string;

    it('mantém apenas uma conta padrão por organização', async () => {
      const accounts = await req(alpha.cookie).get('/api/v1/bank-accounts');
      accountId = accounts.json().data[0].id;

      const second = await req(alpha.cookie).post('/api/v1/bank-accounts', {
        name: 'Conta Secundária',
        type: 'SAVINGS',
        initialBalanceCents: 0,
        initialBalanceDate: '2026-01-01',
        isDefault: true,
      });
      expect(second.statusCode).toBe(201);
      secondAccountId = second.json().id;

      const list = await req(alpha.cookie).get('/api/v1/bank-accounts');
      const defaults = (list.json().data as Array<{ isDefault: boolean }>).filter((a) => a.isDefault);
      expect(defaults).toHaveLength(1);
      expect((list.json().data as Array<{ id: string; isDefault: boolean }>).find((a) => a.id === secondAccountId)!.isDefault).toBe(true);
    });

    it('registra lançamento manual e reflete no extrato e no saldo', async () => {
      const res = await req(alpha.cookie).post(
        `/api/v1/bank-accounts/${secondAccountId}/manual-transactions`,
        { direction: 'IN', amountCents: 150000, occurredAt: '2026-11-04', description: 'Aporte do sócio' },
      );
      expect(res.statusCode).toBe(201);

      const statement = await req(alpha.cookie).get(
        `/api/v1/bank-accounts/${secondAccountId}/statement?from=2026-11-01&to=2026-11-30`,
      );
      expect(statement.json().inflowCents).toBe(150000);
      expect(statement.json().closingBalanceCents).toBe(150000);
      expect(statement.json().transactions[0].runningBalanceCents).toBe(150000);
    });

    it('não duplica o lançamento manual com a mesma Idempotency-Key', async () => {
      const headers = { 'idempotency-key': 'manual-teste-1' };
      const a = await req(alpha.cookie).post(
        `/api/v1/bank-accounts/${secondAccountId}/manual-transactions`,
        { direction: 'OUT', amountCents: 5000, occurredAt: '2026-11-05', description: 'Tarifa' },
        headers,
      );
      const b = await req(alpha.cookie).post(
        `/api/v1/bank-accounts/${secondAccountId}/manual-transactions`,
        { direction: 'OUT', amountCents: 5000, occurredAt: '2026-11-05', description: 'Tarifa' },
        headers,
      );
      expect(a.json().id).toBe(b.json().id);
      const statement = await req(alpha.cookie).get(
        `/api/v1/bank-accounts/${secondAccountId}/statement?from=2026-11-01&to=2026-11-30`,
      );
      expect(statement.json().outflowCents).toBe(5000);
    });

    it('exporta o extrato em CSV com as mesmas linhas', async () => {
      const res = await req(alpha.cookie).get(
        `/api/v1/bank-accounts/${secondAccountId}/statement.csv?from=2026-11-01&to=2026-11-30`,
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      const lines = res.body.replace(/^\uFEFF/, '').trim().split('\r\n');
      expect(lines[0]).toContain('Data');
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain('Aporte do sócio');
    });

    it('cria conta a pagar, paga e atualiza status + extrato', async () => {
      const categories = await req(alpha.cookie).get('/api/v1/expense-categories');
      const categoryId = (categories.json().data as Array<{ id: string; label: string }>).find(
        (c) => c.label === 'Seguro',
      )!.id;

      const created = await req(alpha.cookie).post('/api/v1/payables', {
        categoryId,
        description: 'SEGURO TESTE',
        amountCents: 20000,
        dueDate: '2026-11-20',
        supplierName: 'SEGURADORA X',
        supplierTaxId: '11.222.333/0001-81',
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().status).toBe('PENDING');
      payableId = created.json().id;

      const paid = await req(alpha.cookie).post(`/api/v1/payables/${payableId}/payments`, {
        amountCents: 20000,
        paidAt: '2026-11-10',
        method: 'PIX',
        bankAccountId: accountId,
      });
      expect(paid.statusCode).toBe(201);
      expect(paid.json().payable.status).toBe('PAID');
      expect(paid.json().payable.remainingCents).toBe(0);
    });

    it('não aceita pagamento maior que o saldo em aberto', async () => {
      const categories = await req(alpha.cookie).get('/api/v1/expense-categories');
      const categoryId = categories.json().data[0].id;
      const created = await req(alpha.cookie).post('/api/v1/payables', {
        categoryId,
        description: 'CONTA PARCIAL',
        amountCents: 10000,
        dueDate: '2026-11-25',
      });
      const id = created.json().id;
      const res = await req(alpha.cookie).post(`/api/v1/payables/${id}/payments`, {
        amountCents: 15000,
        paidAt: '2026-11-11',
        method: 'CASH',
        bankAccountId: accountId,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.message).toContain('maior que o saldo');
    });

    it('recebimento parcial mantém o saldo pendente e é idempotente', async () => {
      const receivables = await req(alpha.cookie).get('/api/v1/receivables?limit=50');
      const target = (receivables.json().data as Array<{ id: string; remainingCents: number }>).find(
        (r) => r.remainingCents > 10000,
      )!;

      const headers = { 'idempotency-key': 'receb-teste-1' };
      const first = await req(alpha.cookie).post(
        `/api/v1/receivables/${target.id}/payments`,
        { amountCents: 10000, paidAt: '2026-11-12', method: 'PIX', bankAccountId: accountId },
        headers,
      );
      expect(first.statusCode).toBe(201);
      expect(first.json().receivable.remainingCents).toBe(target.remainingCents - 10000);

      const retry = await req(alpha.cookie).post(
        `/api/v1/receivables/${target.id}/payments`,
        { amountCents: 10000, paidAt: '2026-11-12', method: 'PIX', bankAccountId: accountId },
        headers,
      );
      expect(retry.statusCode).toBe(200);
      expect(retry.json().receivable.remainingCents).toBe(target.remainingCents - 10000);
    });

    it('lista contas a receber em aberto do motorista e da locação (atalho de baixa)', async () => {
      const all = await req(alpha.cookie).get('/api/v1/receivables?limit=50');
      const sample = (
        all.json().data as Array<{
          driver: { id: string };
          rental: { id: string } | null;
          remainingCents: number;
        }>
      ).find((r) => r.remainingCents > 0 && r.rental)!;

      const byDriver = await req(alpha.cookie).get(
        `/api/v1/receivables?driverId=${sample.driver.id}&openOnly=true`,
      );
      expect(byDriver.statusCode).toBe(200);
      const driverRows = byDriver.json().data as Array<{ driver: { id: string }; remainingCents: number }>;
      expect(driverRows.length).toBeGreaterThan(0);
      expect(driverRows.every((r) => r.driver.id === sample.driver.id && r.remainingCents > 0)).toBe(true);

      const byRental = await req(alpha.cookie).get(
        `/api/v1/receivables?rentalId=${sample.rental!.id}&openOnly=true`,
      );
      const rentalRows = byRental.json().data as Array<{ rental: { id: string } | null }>;
      expect(rentalRows.length).toBeGreaterThan(0);
      expect(rentalRows.every((r) => r.rental?.id === sample.rental!.id)).toBe(true);
    });

    it('dois recebimentos iguais com chaves diferentes são registrados separadamente', async () => {
      const receivables = await req(alpha.cookie).get('/api/v1/receivables?limit=50');
      const target = (receivables.json().data as Array<{ id: string; remainingCents: number }>).find(
        (r) => r.remainingCents > 20000,
      )!;
      const body = { amountCents: 5000, paidAt: '2026-11-13', method: 'PIX', bankAccountId: accountId };
      const a = await req(alpha.cookie).post(`/api/v1/receivables/${target.id}/payments`, body, {
        'idempotency-key': 'receb-igual-1',
      });
      const b = await req(alpha.cookie).post(`/api/v1/receivables/${target.id}/payments`, body, {
        'idempotency-key': 'receb-igual-2',
      });
      expect(a.statusCode).toBe(201);
      expect(b.statusCode).toBe(201);
      expect(b.json().receivable.remainingCents).toBe(target.remainingCents - 10000);
    });

    it('categorias padrão incluem IPVA, Licenciamento e Outro sem duplicar', async () => {
      await req(alpha.cookie).get('/api/v1/expense-categories');
      const res = await req(alpha.cookie).get('/api/v1/expense-categories');
      const labels = (res.json().data as Array<{ label: string }>).map((c) => c.label);
      for (const label of ['Financiamento', 'Seguro', 'IPVA', 'Licenciamento', 'Outro']) {
        expect(labels.filter((l) => l === label)).toHaveLength(1);
      }
    });

    it('excluir conta paga gera estorno em vez de apagar o extrato', async () => {
      const before = await req(alpha.cookie).get(
        `/api/v1/bank-accounts/${accountId}/statement?from=2026-11-01&to=2026-11-30`,
      );
      const res = await req(alpha.cookie).del(`/api/v1/payables/${payableId}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().reversed).toBe(true);

      const after = await req(alpha.cookie).get(
        `/api/v1/bank-accounts/${accountId}/statement?from=2026-11-01&to=2026-11-30`,
      );
      expect(after.json().transactions.length).toBe(before.json().transactions.length + 1);
      const payable = await req(alpha.cookie).get(`/api/v1/payables/${payableId}`);
      expect(payable.json().status).toBe('CANCELED');
    });
  });

  /* --------------------------- T10 / T11 --------------------------- */
  describe('T10/T11 — vistorias e configuração de fotos', () => {
    let vehicleId: string;

    it('entrega os cinco slots padrão da referência', async () => {
      const res = await req(alpha.cookie).get('/api/v1/inspection/photo-slots');
      expect(res.statusCode).toBe(200);
      const codes = (res.json().data as Array<{ code: string }>).map((s) => s.code);
      expect(codes).toEqual(['FRONT', 'REAR', 'LEFT_SIDE', 'RIGHT_SIDE', 'DASHBOARD']);
      expect(res.json().maxActive).toBe(12);
    });

    it('bloqueia mais de 12 slots ativos', async () => {
      const current = await req(alpha.cookie).get('/api/v1/inspection/photo-slots');
      const slots = (current.json().data as Array<{ id: string; label: string }>).map((s) => ({
        id: s.id,
        label: s.label,
        active: true,
      }));
      for (let i = 0; i < 8; i++) slots.push({ id: undefined as never, label: `Extra ${i}`, active: true });
      const res = await req(alpha.cookie).put('/api/v1/inspection/photo-slots', { slots });
      expect(res.statusCode).toBe(422);
    });

    it('solicita vistoria e declara a indisponibilidade do WhatsApp sem fingir envio', async () => {
      const vehicle = await req(alpha.cookie).post('/api/v1/vehicles', {
        plate: 'KKK1K11',
        brand: 'VW',
        model: 'NIVUS',
      });
      vehicleId = vehicle.json().id;

      const res = await req(alpha.cookie).post(`/api/v1/vehicles/${vehicleId}/inspections/request`, {
        responsibleName: 'Responsável Teste',
        phone: '11999990020',
        scheduledAt: '2026-11-12',
      });
      expect(res.statusCode).toBe(201);
      const inspection = res.json().inspection;
      expect(inspection.status).toBe('PENDING');
      expect(inspection.delivery.status).toBe('UNAVAILABLE');
      expect(inspection.delivery.manualLink).toContain('wa.me');
      expect(res.json().link).toContain('/vistoria/');
    });

    it('o formulário público exige todas as fotos ativas antes de concluir', async () => {
      const request = await req(alpha.cookie).post(
        `/api/v1/vehicles/${vehicleId}/inspections/request`,
        { responsibleName: 'Outro Responsável', phone: '11999990021', scheduledAt: '2026-11-13' },
      );
      const token = (request.json().link as string).split('/').pop()!;

      const form = await harness.app.inject({ method: 'GET', url: `/api/v1/inspection-public/${token}` });
      expect(form.statusCode).toBe(200);
      expect(form.json().slots.length).toBeGreaterThanOrEqual(5);

      const incomplete = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/inspection-public/${token}/submit`,
        payload: {
          odometerKm: 1000,
          photos: [{ slotCode: 'FRONT', fileId: new ObjectId().toHexString() }],
        },
      });
      expect(incomplete.statusCode).toBe(400);
      expect(incomplete.json().error.message).toContain('Faltando');
    });

    it('rejeita token de vistoria inexistente', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/inspection-public/token-invalido',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  /* ------------------------------- T17 ----------------------------- */
  describe('T17 — disparo de mensagens', () => {
    it('rejeita disparo sem destinatários ou sem consentimento', async () => {
      const semDestinatario = await req(alpha.cookie).post('/api/v1/message-dispatches', {
        body: 'Olá {{nome_motorista}}',
        driverIds: [],
        consentConfirmed: true,
      });
      expect(semDestinatario.statusCode).toBe(422);

      const drivers = await req(alpha.cookie).get('/api/v1/drivers?limit=5');
      const ids = (drivers.json().data as Array<{ id: string }>).map((d) => d.id);
      const semConsentimento = await req(alpha.cookie).post('/api/v1/message-dispatches', {
        body: 'Olá {{nome_motorista}}',
        driverIds: ids.slice(0, 1),
        consentConfirmed: false,
      });
      expect(semConsentimento.statusCode).toBe(422);
    });

    it('registra o disparo como indisponível quando não há provedor e renderiza os tokens', async () => {
      const drivers = await req(alpha.cookie).get('/api/v1/drivers?limit=5');
      const list = drivers.json().data as Array<{ id: string; fullName: string }>;
      const res = await req(alpha.cookie).post('/api/v1/message-dispatches', {
        body: 'Olá, *{{nome_motorista}}*! Equipe {{nome_empresa}}',
        driverIds: list.slice(0, 2).map((d) => d.id),
        consentConfirmed: true,
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.providerAvailable).toBe(false);
      expect(body.summary.sent).toBe(0);
      expect(body.summary.unavailable).toBe(2);
      const selected = list.slice(0, 2).map((d) => d.fullName).sort();
      const rendered = (body.deliveries as Array<{ driverName: string; renderedBody: string }>)
        .map((d) => d.driverName)
        .sort();
      expect(rendered).toEqual(selected);
      for (const delivery of body.deliveries as Array<{ driverName: string; renderedBody: string; manualLink: string }>) {
        expect(delivery.renderedBody).toContain(delivery.driverName);
        expect(delivery.renderedBody).toContain('Alpha Locadora');
        expect(delivery.manualLink).toContain('wa.me');
      }
    });

    it('reenvio é bloqueado enquanto o provedor não estiver conectado', async () => {
      const history = await req(alpha.cookie).get('/api/v1/message-dispatches');
      const id = history.json().data[0].id;
      const res = await req(alpha.cookie).post(`/api/v1/message-dispatches/${id}/retry`, {});
      expect(res.statusCode).toBe(409);
    });
  });

  /* ------------------------------- T19 ----------------------------- */
  describe('T19 — perfil e troca de senha', () => {
    it('exige a senha atual correta e revoga as demais sessões', async () => {
      const org = await createOrg('Delta Locadora', 'delta@exemplo.test', 'Delta@123456');
      const second = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'delta@exemplo.test', password: 'Delta@123456' },
      });
      const secondCookie = sessionCookie(second.headers as Record<string, unknown>);

      const wrong = await req(org.cookie).post('/api/v1/auth/password/change', {
        currentPassword: 'errada',
        newPassword: 'NovaSenha@1',
        confirmPassword: 'NovaSenha@1',
      });
      expect(wrong.statusCode).toBe(400);

      const mismatch = await req(org.cookie).post('/api/v1/auth/password/change', {
        currentPassword: 'Delta@123456',
        newPassword: 'NovaSenha@1',
        confirmPassword: 'Outra@1',
      });
      expect(mismatch.statusCode).toBe(422);

      const ok = await req(org.cookie).post('/api/v1/auth/password/change', {
        currentPassword: 'Delta@123456',
        newPassword: 'NovaSenha@1',
        confirmPassword: 'NovaSenha@1',
      });
      expect(ok.statusCode).toBe(200);

      // A sessão que trocou a senha segue válida; a outra foi revogada.
      expect((await req(org.cookie).get('/api/v1/auth/me')).statusCode).toBe(200);
      expect((await req(secondCookie).get('/api/v1/auth/me')).statusCode).toBe(401);
    });
  });

  /* ------------------------------- T21 ----------------------------- */
  describe('T21 — contratos de erro da API', () => {
    it('404 para rota inexistente', async () => {
      const res = await req(alpha.cookie).get('/api/v1/nao-existe');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });

    it('400 para identificador malformado', async () => {
      const res = await req(alpha.cookie).get('/api/v1/vehicles/123');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
    });

    it('422 lista os campos inválidos', async () => {
      const res = await req(alpha.cookie).post('/api/v1/vehicles', { plate: 'EEE' });
      expect(res.statusCode).toBe(422);
      const details = res.json().error.details as Array<{ path: string }>;
      expect(details.some((d) => d.path === 'plate')).toBe(true);
      expect(details.some((d) => d.path === 'brand')).toBe(true);
    });

    it('toda resposta de erro carrega requestId', async () => {
      const res = await req(alpha.cookie).get('/api/v1/vehicles/123');
      expect(res.json().error.requestId).toBeTruthy();
    });

    it('expõe o estado real das integrações', async () => {
      const res = await req(alpha.cookie).get('/api/v1/integrations/status');
      const body = res.json();
      expect(body.whatsapp.connected).toBe(false);
      expect(body.billing.connected).toBe(false);
      expect(body.trafficFines.connected).toBe(false);
    });

    it('health e ready respondem', async () => {
      expect((await harness.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      const ready = await harness.app.inject({ method: 'GET', url: '/ready' });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().transactions).toBe(true);
    });
  });
});
