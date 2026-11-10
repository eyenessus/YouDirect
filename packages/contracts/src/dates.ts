import { BUSINESS_TIMEZONE } from './common.js';
import { monthNamesPtBr, monthShortPtBr } from './enums.js';

/* ------------------------------------------------------------------ *
 * Datas de negócio.
 * Persistência: `Date` UTC. Apresentação e agregações: fuso de negócio
 * (America/Sao_Paulo). Datas puras (vencimento, competência) trafegam
 * como string `YYYY-MM-DD` para não sofrer deslocamento de fuso.
 * ------------------------------------------------------------------ */

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Data de negócio (YYYY-MM-DD) de um instante. */
export function businessDate(instant: Date = new Date()): string {
  return partsFormatter.format(instant);
}

const dateTimePartsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Diferença (ms) entre o relógio do fuso de negócio e o UTC num instante. */
function businessOffsetMs(instant: number): number {
  const parts = Object.fromEntries(
    dateTimePartsFormatter.formatToParts(new Date(instant)).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - (instant - (instant % 1000));
}

/**
 * Data (`YYYY-MM-DD`) e hora (`HH:MM`) no fuso de negócio → instante UTC.
 * Ex.: 2026-11-10 23:30 em São Paulo → 2026-11-11T02:30:00.000Z.
 */
export function zonedDateTimeToUtc(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let instant = wall - businessOffsetMs(wall);
  // Segunda passada: corrige quando o offset muda entre o palpite e o resultado.
  instant = wall - businessOffsetMs(instant);
  return new Date(instant);
}

/** Hora local (`HH:MM`) no fuso de negócio de um instante. */
export function businessTime(instant: Date): string {
  const parts = Object.fromEntries(
    dateTimePartsFormatter.formatToParts(instant).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return `${parts.hour}:${parts.minute}`;
}

/** Converte `YYYY-MM-DD` em `Date` UTC à meia-noite (chave de competência). */
export function isoDateToUtc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function utcToIsoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function addDaysIso(date: string, days: number): string {
  const d = isoDateToUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonthsIso(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, lastDay));
  return base.toISOString().slice(0, 10);
}

export function diffDaysIso(a: string, b: string): number {
  return Math.round((isoDateToUtc(a).getTime() - isoDateToUtc(b).getTime()) / 86_400_000);
}

export function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function monthRange(year: number, month: number): { from: string; to: string } {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const to = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}

export function previousMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

export function monthLabel(year: number, month: number): string {
  return `${monthNamesPtBr[month - 1]} ${year}`;
}

export function monthShortLabel(monthKeyValue: string): string {
  const [, m] = monthKeyValue.split('-');
  return monthShortPtBr[Number(m) - 1] ?? monthKeyValue;
}

/** Janela de comparação do mesmo comprimento imediatamente anterior. */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const days = diffDaysIso(to, from) + 1;
  const prevTo = addDaysIso(from, -1);
  return { from: addDaysIso(prevTo, -(days - 1)), to: prevTo };
}

/** Últimos `count` meses terminando no mês informado (inclusive). */
export function lastMonths(year: number, month: number, count: number): Array<{ year: number; month: number; key: string }> {
  const out: Array<{ year: number; month: number; key: string }> = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    out.push({ year: y, month: m, key: `${y}-${String(m).padStart(2, '0')}` });
  }
  return out;
}

/**
 * Variação percentual segura: retorna `null` quando não há base de
 * comparação (evita Infinity / porcentagem fictícia).
 */
export function percentDelta(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const formatted = new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
  return `${formatted}%`;
}

export function formatSignedPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  // A referência exibe "+0%" quando não há variação (pág. 014).
  const prefix = value >= 0 ? '+' : '';
  return `${prefix}${formatPercent(value, digits)}`;
}

/** Tempo relativo curto usado no popover de notificações ("9 d", "3 h"). */
export function shortRelativeTime(from: Date | string, now: Date = new Date()): string {
  const d = typeof from === 'string' ? new Date(from) : from;
  const seconds = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 1000));
  if (seconds < 60) return 'agora';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} m`;
  return `${Math.floor(months / 12)} a`;
}

export function formatDateTimeBR(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: BUSINESS_TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function formatLongDateBR(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} de ${monthNamesPtBr[m - 1].toLowerCase()} de ${y}`;
}

export function formatShortDateBR(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${String(d).padStart(2, '0')} de ${monthShortPtBr[m - 1].toLowerCase()}. de ${y}`;
}
