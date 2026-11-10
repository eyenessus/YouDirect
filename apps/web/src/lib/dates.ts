/**
 * Data de HOJE no fuso do navegador, em AAAA-MM-DD.
 * `new Date().toISOString().slice(0, 10)` usa UTC: depois das 21h (Brasília)
 * já devolve o dia seguinte — pagamentos e vistorias caíam na data errada.
 */
export function todayLocalIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
