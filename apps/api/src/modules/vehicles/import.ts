import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import {
  isValidPlate,
  normalizePlate,
  parseBRLToCents,
  VEHICLE_IMPORT_MAX_ROWS,
  vehicleImportCommitRequestSchema,
  type VehicleImportPreview,
  type VehicleImportRow,
} from '@yudirect/contracts';
import { badRequest, notFound } from '../../common/errors.js';
import { generateToken } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { audit } from '../../services/common.js';
import type { VehicleDoc } from '../../database/types.js';

const TEMPLATE_HEADERS = [
  'placa',
  'renavam',
  'chassi',
  'marca',
  'modelo',
  'ano',
  'cor',
  'hodometro',
  'uf_emplacamento',
  'municipio_emplacamento',
  'data_compra',
  'valor_compra',
] as const;

const HEADER_ALIASES: Record<string, (typeof TEMPLATE_HEADERS)[number]> = {
  placa: 'placa',
  plate: 'placa',
  renavam: 'renavam',
  chassi: 'chassi',
  chassis: 'chassi',
  vin: 'chassi',
  marca: 'marca',
  brand: 'marca',
  modelo: 'modelo',
  model: 'modelo',
  ano: 'ano',
  year: 'ano',
  cor: 'cor',
  color: 'cor',
  hodometro: 'hodometro',
  'hodômetro': 'hodometro',
  km: 'hodometro',
  quilometragem: 'hodometro',
  uf: 'uf_emplacamento',
  uf_emplacamento: 'uf_emplacamento',
  municipio: 'municipio_emplacamento',
  'município': 'municipio_emplacamento',
  municipio_emplacamento: 'municipio_emplacamento',
  cidade: 'municipio_emplacamento',
  data_compra: 'data_compra',
  'data da compra': 'data_compra',
  valor_compra: 'valor_compra',
  'valor da compra': 'valor_compra',
  'preco da compra': 'valor_compra',
};

function normalizeHeader(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function parseDateCell(raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return undefined;
}

interface RawRow {
  line: number;
  cells: Record<string, string>;
}

async function readRows(buffer: Buffer, fileName: string): Promise<RawRow[]> {
  const isCsv = /\.csv$/i.test(fileName) || buffer.subarray(0, 2).toString('latin1') !== 'PK';
  if (isCsv) {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    // A detecção automática de delimitador quebra valores pt-BR como
    // "68.000,00"; escolhemos o separador pela linha de cabeçalho.
    const headerLine = text.split(/\r?\n/, 1)[0] ?? '';
    const counts: Array<[string, number]> = [
      [';', (headerLine.match(/;/g) ?? []).length],
      ['\t', (headerLine.match(/\t/g) ?? []).length],
      [',', (headerLine.match(/,/g) ?? []).length],
    ];
    counts.sort((a, b) => b[1] - a[1]);
    const delimiter = counts[0]![1] > 0 ? counts[0]![0] : ';';

    const records = parseCsv(text, {
      columns: (header: string[]) => header.map((h) => HEADER_ALIASES[normalizeHeader(h)] ?? normalizeHeader(h)),
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      delimiter,
    }) as Record<string, string>[];
    return records.map((cells, idx) => ({ line: idx + 2, cells }));
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw badRequest('A planilha não possui abas legíveis.');
  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    const raw = String(cell.value ?? '').trim();
    headers[col] = HEADER_ALIASES[normalizeHeader(raw)] ?? normalizeHeader(raw);
  });

  const rows: RawRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells: Record<string, string> = {};
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const key = headers[col];
      if (!key) return;
      const value = cell.value;
      if (value === null || value === undefined) {
        cells[key] = '';
      } else if (value instanceof Date) {
        cells[key] = value.toISOString().slice(0, 10);
      } else if (typeof value === 'object' && 'text' in (value as object)) {
        cells[key] = String((value as { text: string }).text);
      } else if (typeof value === 'object' && 'result' in (value as object)) {
        cells[key] = String((value as { result: unknown }).result ?? '');
      } else {
        cells[key] = String(value);
      }
    });
    rows.push({ line: rowNumber, cells });
  });
  return rows;
}

function validateRow(raw: RawRow): VehicleImportRow {
  const cells = raw.cells;
  const errors: string[] = [];
  const plateRaw = (cells.placa ?? '').trim();
  const plate = normalizePlate(plateRaw);
  if (!plateRaw) errors.push('Placa é obrigatória.');
  else if (!isValidPlate(plateRaw)) errors.push(`Placa "${plateRaw}" inválida (use ABC1D23 ou ABC1234).`);

  const brand = (cells.marca ?? '').trim();
  if (!brand) errors.push('Marca é obrigatória.');
  const model = (cells.modelo ?? '').trim();
  if (!model) errors.push('Modelo é obrigatório.');

  const renavamRaw = (cells.renavam ?? '').replace(/\D+/g, '');
  if (renavamRaw && (renavamRaw.length < 9 || renavamRaw.length > 11))
    errors.push('Renavam deve ter entre 9 e 11 dígitos.');

  const vinRaw = (cells.chassi ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (vinRaw && vinRaw.length !== 17) errors.push('Chassi deve ter 17 caracteres.');

  let year: number | undefined;
  const yearRaw = (cells.ano ?? '').trim();
  if (yearRaw) {
    const parsed = Number(yearRaw.replace(/\D+/g, ''));
    if (!Number.isInteger(parsed) || parsed < 1900 || parsed > new Date().getFullYear() + 2)
      errors.push(`Ano "${yearRaw}" inválido.`);
    else year = parsed;
  }

  let mileageKm: number | undefined;
  const kmRaw = (cells.hodometro ?? '').trim();
  if (kmRaw) {
    const parsed = Number(kmRaw.replace(/\./g, '').replace(/[^\d]/g, ''));
    if (!Number.isInteger(parsed) || parsed < 0) errors.push(`Hodômetro "${kmRaw}" inválido.`);
    else mileageKm = parsed;
  }

  const stateRaw = (cells.uf_emplacamento ?? '').trim().toUpperCase();
  if (stateRaw && stateRaw.length !== 2) errors.push('UF de emplacamento deve ter 2 letras.');

  const purchaseDate = (cells.data_compra ?? '').trim() ? parseDateCell(cells.data_compra ?? '') : undefined;
  if ((cells.data_compra ?? '').trim() && !purchaseDate)
    errors.push('Data de compra inválida (use DD/MM/AAAA).');

  const purchaseRaw = (cells.valor_compra ?? '').trim();
  const purchaseAmountCents = purchaseRaw ? parseBRLToCents(purchaseRaw) : undefined;
  if (purchaseRaw && (purchaseAmountCents === undefined || purchaseAmountCents < 0))
    errors.push('Valor de compra inválido.');

  return {
    line: raw.line,
    data: {
      plate,
      renavam: renavamRaw || undefined,
      vin: vinRaw || undefined,
      brand,
      model,
      year,
      color: (cells.cor ?? '').trim() || undefined,
      mileageKm,
      registrationState: stateRaw || undefined,
      registrationCity: (cells.municipio_emplacamento ?? '').trim() || undefined,
      purchaseDate,
      purchaseAmountCents,
    },
    errors,
    duplicateInFile: false,
    existsInOrganization: false,
  };
}

export async function registerVehicleImportRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------- planilha modelo ---------------------- */
  app.get(
    '/vehicles/import/template',
    { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'create')] },
    async (_request, reply) => {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'YuDirect';
      const sheet = workbook.addWorksheet('Veículos');
      sheet.columns = TEMPLATE_HEADERS.map((h) => ({ header: h, key: h, width: 22 }));
      sheet.getRow(1).font = { bold: true };
      sheet.addRow({
        placa: 'ABC1D23',
        renavam: '12345678901',
        chassi: '9BWZZZ377VT004251',
        marca: 'Chevrolet',
        modelo: 'Onix 1.0',
        ano: 2026,
        cor: 'Prata',
        hodometro: 0,
        uf_emplacamento: 'SP',
        municipio_emplacamento: 'São Paulo',
        data_compra: '01/01/2026',
        valor_compra: '55.000,00',
      });
      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      reply
        .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', 'attachment; filename="modelo-importacao-veiculos.xlsx"');
      return reply.send(buffer);
    },
  );

  /* ------------------------------ preview -------------------------- */
  app.post(
    '/vehicles/import/preview',
    { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'create')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const file = await request.file({ limits: { fileSize: 5 * 1024 * 1024 } });
      if (!file) throw badRequest('Envie a planilha no campo "file".');
      const buffer = await file.toBuffer();
      if (buffer.byteLength === 0) throw badRequest('Planilha vazia.');

      const rawRows = await readRows(buffer, file.filename ?? 'planilha.csv');
      if (rawRows.length === 0) throw badRequest('Nenhuma linha de dados encontrada na planilha.');
      if (rawRows.length > VEHICLE_IMPORT_MAX_ROWS) {
        throw badRequest(
          `A planilha possui ${rawRows.length} linhas. O limite por importação é de ${VEHICLE_IMPORT_MAX_ROWS} veículos.`,
        );
      }

      const rows = rawRows.map(validateRow);

      const seen = new Map<string, number>();
      for (const row of rows) {
        if (!row.data.plate) continue;
        const prev = seen.get(row.data.plate);
        if (prev !== undefined) {
          row.duplicateInFile = true;
          row.errors.push(`Placa repetida na planilha (linha ${prev}).`);
        } else {
          seen.set(row.data.plate, row.line);
        }
      }

      const plates = rows.map((r) => r.data.plate).filter(Boolean);
      const existing = await ctx.mongo.collections.vehicles
        .find({ organizationId: auth.organizationId, archivedAt: null, plate: { $in: plates } })
        .project<{ plate: string }>({ plate: 1 })
        .toArray();
      const existingPlates = new Set(existing.map((e) => e.plate));
      for (const row of rows) {
        if (existingPlates.has(row.data.plate)) {
          row.existsInOrganization = true;
          row.errors.push('Já existe um veículo com esta placa na organização.');
        }
      }

      const token = generateToken(18);
      await ctx.mongo.collections.importDrafts.insertOne({
        _id: new ObjectId(),
        organizationId: auth.organizationId,
        userId: auth.userId,
        token,
        fileName: file.filename ?? 'planilha',
        rows,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      const preview: VehicleImportPreview = {
        token,
        fileName: file.filename ?? 'planilha',
        totalRows: rows.length,
        validRows: rows.filter((r) => r.errors.length === 0).length,
        invalidRows: rows.filter((r) => r.errors.length > 0).length,
        limit: VEHICLE_IMPORT_MAX_ROWS,
        rows,
      };
      return preview;
    },
  );

  /* ------------------------------- commit -------------------------- */
  app.post(
    '/vehicles/import/commit',
    { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'create')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = vehicleImportCommitRequestSchema.parse(request.body);

      const draft = await ctx.mongo.collections.importDrafts.findOne({
        token: body.token,
        organizationId: auth.organizationId,
      });
      if (!draft) throw notFound('Pré-visualização expirada. Envie a planilha novamente.');

      const rows = draft.rows as VehicleImportRow[];
      const selected = new Set(body.lines);
      const errors: Array<{ line: number; message: string }> = [];
      const docs: VehicleDoc[] = [];
      const now = new Date();

      for (const row of rows) {
        if (!selected.has(row.line)) continue;
        if (row.errors.length > 0) {
          errors.push({ line: row.line, message: row.errors.join(' ') });
          continue;
        }
        docs.push({
          _id: new ObjectId(),
          organizationId: auth.organizationId,
          plate: row.data.plate,
          renavam: row.data.renavam ?? null,
          vin: row.data.vin ?? null,
          brand: row.data.brand,
          model: row.data.model,
          brandLower: row.data.brand.toLowerCase(),
          modelLower: row.data.model.toLowerCase(),
          year: row.data.year ?? null,
          color: row.data.color ?? null,
          colorLower: row.data.color?.toLowerCase() ?? null,
          mileageKm: row.data.mileageKm ?? 0,
          registration: {
            state: row.data.registrationState ?? null,
            city: row.data.registrationCity ?? null,
          },
          purchase: {
            date: row.data.purchaseDate ?? null,
            amountCents: row.data.purchaseAmountCents ?? null,
          },
          photoFileIds: [],
          status: 'AVAILABLE',
          archivedAt: null,
          createdBy: auth.userId,
          createdAt: now,
          updatedAt: now,
          version: 1,
        });
      }

      let created = 0;
      if (docs.length > 0) {
        // `ordered: false` + índice único garantem que uma linha quebrada
        // não derruba a importação inteira nem grava duplicatas.
        try {
          const result = await ctx.mongo.collections.vehicles.insertMany(docs, { ordered: false });
          created = result.insertedCount;
        } catch (err) {
          const writeErrors = (err as { writeErrors?: Array<{ index: number; errmsg: string }> }).writeErrors;
          created =
            (err as { result?: { insertedCount?: number } }).result?.insertedCount ??
            docs.length - (writeErrors?.length ?? 0);
          for (const we of writeErrors ?? []) {
            const doc = docs[we.index];
            errors.push({
              line: rows.find((r) => r.data.plate === doc?.plate)?.line ?? -1,
              message: 'Placa, Renavam ou chassi já cadastrado.',
            });
          }
        }
      }

      await ctx.mongo.collections.importDrafts.deleteOne({ _id: draft._id });
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'vehicle.imported',
        entityType: 'vehicle',
        entityId: null,
        after: { created, requested: body.lines.length, fileName: draft.fileName },
      });

      return { created, skipped: body.lines.length - created, errors };
    },
  );
}
