import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Primitivos compartilhados entre API e Web.
 * Dinheiro SEMPRE em centavos inteiros (nunca float).
 * ------------------------------------------------------------------ */

export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Identificador inválido');

export const amountCentsSchema = z
  .number()
  .int('Use centavos inteiros')
  .min(0, 'Valor não pode ser negativo')
  .max(Number.MAX_SAFE_INTEGER);

export const signedAmountCentsSchema = z.number().int();

/** Data no formato ISO `YYYY-MM-DD` (data de negócio, sem fuso). */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve estar no formato AAAA-MM-DD')
  .refine((v) => {
    const parsed = new Date(`${v}T00:00:00.000Z`);
    // Ida e volta: rejeita 2026-02-30, 2026-04-31 etc. (o JS "rola" para o mês seguinte).
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
  }, 'Data inválida');

export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const nonEmptyString = (max = 255) =>
  z.string().trim().min(1, 'Campo obrigatório').max(max, `Máximo de ${max} caracteres`);

export const optionalString = (max = 255) =>
  z
    .string()
    .trim()
    .max(max, `Máximo de ${max} caracteres`)
    .optional()
    .or(z.literal('').transform(() => undefined));

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('E-mail inválido')
  .max(254);

/** Telefone BR: aceita máscara, persiste apenas dígitos (10 ou 11). */
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D+/g, ''))
  .refine((v) => v.length === 10 || v.length === 11, 'Telefone deve ter 10 ou 11 dígitos');

export const optionalPhoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D+/g, ''))
  .refine((v) => v === '' || v.length === 10 || v.length === 11, 'Telefone deve ter 10 ou 11 dígitos')
  .transform((v) => (v === '' ? undefined : v))
  .optional();

/* ------------------------------ CPF / CNPJ ------------------------- */

export function isValidCpf(raw: string): boolean {
  const cpf = raw.replace(/\D+/g, '');
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;
  const digits = cpf.split('').map(Number);
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += digits[i] * (len + 1 - i);
    let check = (sum * 10) % 11;
    if (check === 10) check = 0;
    if (check !== digits[len]) return false;
  }
  return true;
}

export function isValidCnpj(raw: string): boolean {
  const cnpj = raw.replace(/\D+/g, '');
  if (cnpj.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;
  const digits = cnpj.split('').map(Number);
  const calc = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += digits[i] * weights[i];
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return calc(12) === digits[12] && calc(13) === digits[13];
}

export const cpfSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D+/g, ''))
  .refine((v) => isValidCpf(v), 'CPF inválido');

export const optionalCpfSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D+/g, ''))
  .refine((v) => v === '' || isValidCpf(v), 'CPF inválido')
  .transform((v) => (v === '' ? undefined : v))
  .optional();

export const optionalCnpjSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D+/g, ''))
  .refine((v) => v === '' || isValidCnpj(v), 'CNPJ inválido')
  .transform((v) => (v === '' ? undefined : v))
  .optional();

/* ------------------------------- Placa ----------------------------- */

const PLATE_MERCOSUL = /^[A-Z]{3}\d[A-Z]\d{2}$/;
const PLATE_LEGACY = /^[A-Z]{3}\d{4}$/;

export function normalizePlate(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidPlate(raw: string): boolean {
  const p = normalizePlate(raw);
  return PLATE_MERCOSUL.test(p) || PLATE_LEGACY.test(p);
}

export const plateSchema = z
  .string()
  .trim()
  .transform(normalizePlate)
  .refine(isValidPlate, 'Placa inválida — use o formato Mercosul (ABC1D23) ou antigo (ABC1234)');

/* ------------------------- Renavam / Chassi ------------------------ */

export const optionalRenavamSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D+/g, ''))
  .refine((v) => v === '' || (v.length >= 9 && v.length <= 11), 'Renavam deve ter entre 9 e 11 dígitos')
  .transform((v) => (v === '' ? undefined : v))
  .optional();

export const optionalVinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .transform((v) => v.replace(/[^A-Z0-9]/g, ''))
  .refine((v) => v === '' || v.length === 17, 'Chassi deve ter 17 caracteres')
  .transform((v) => (v === '' ? undefined : v))
  .optional();

/* ------------------------------ CEP -------------------------------- */

export const optionalPostalCodeSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D+/g, ''))
  .refine((v) => v === '' || v.length === 8, 'CEP deve ter 8 dígitos')
  .transform((v) => (v === '' ? undefined : v))
  .optional();

export const brazilianStates = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG',
  'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const;

export const stateSchema = z.enum(brazilianStates);
export const optionalStateSchema = z
  .string()
  .trim()
  .toUpperCase()
  .transform((v) => (v === '' ? undefined : v))
  .optional()
  .refine((v) => v === undefined || (brazilianStates as readonly string[]).includes(v), 'UF inválida')
  .transform((v) => v as (typeof brazilianStates)[number] | undefined);

/* --------------------------- Paginação ----------------------------- */

export const paginationQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const pageMetaSchema = z.object({
  nextCursor: z.string().nullable().optional(),
  total: z.number().int().nonnegative().optional(),
});

export function listResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ data: z.array(item), page: pageMetaSchema });
}

/* ------------------------------ Erros ------------------------------ */

export const apiErrorCodes = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'UNPROCESSABLE',
  'RATE_LIMITED',
  'INTERNAL',
  'INTEGRATION_UNAVAILABLE',
] as const;
export type ApiErrorCode = (typeof apiErrorCodes)[number];

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(apiErrorCodes),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/* --------------------------- Formatação ---------------------------- */

export const BUSINESS_TIMEZONE = 'America/Sao_Paulo';

export function formatCentsBRL(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

export function formatCentsPlain(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    cents / 100,
  );
}

/** "1.234,56" | "R$ 1.234,56" | "1234.56" -> 123456 */
export function parseBRLToCents(input: string | number | null | undefined): number {
  if (input === null || input === undefined || input === '') return 0;
  if (typeof input === 'number') return Math.round(input * 100);
  const cleaned = input.replace(/[^\d,.-]/g, '').trim();
  if (cleaned === '') return 0;
  const hasComma = cleaned.includes(',');
  const normalized = hasComma ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned;
  const value = Number(normalized);
  if (Number.isNaN(value)) return 0;
  return Math.round(value * 100);
}

export function formatIsoDateBR(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = iso.slice(0, 10);
  const [y, m, d] = date.split('-');
  if (!y || !m || !d) return '—';
  return `${d}/${m}/${y}`;
}

export function formatKm(km: number | null | undefined): string {
  if (km === null || km === undefined) return '—';
  return `${new Intl.NumberFormat('pt-BR').format(km)} km`;
}

/** Máscaras apenas de apresentação — nunca alteram o valor persistido. */
export function maskCpf(digits: string | null | undefined): string {
  if (!digits) return '—';
  const d = digits.replace(/\D+/g, '');
  if (d.length !== 11) return digits;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

export function maskCnpj(digits: string | null | undefined): string {
  if (!digits) return '—';
  const d = digits.replace(/\D+/g, '');
  if (d.length !== 14) return digits;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

export function maskPhone(digits: string | null | undefined): string {
  if (!digits) return '—';
  const d = digits.replace(/\D+/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return digits;
}

export function maskPostalCode(digits: string | null | undefined): string {
  if (!digits) return '—';
  const d = digits.replace(/\D+/g, '');
  if (d.length !== 8) return digits;
  return `${d.slice(0, 5)}-${d.slice(5)}`;
}
