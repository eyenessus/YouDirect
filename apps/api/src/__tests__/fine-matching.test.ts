import { describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { zonedDateTimeToUtc } from '@yudirect/contracts';
import { matchRental, type MatchableRental } from '../services/fine-matching.js';

const rental = (startDate: string, endDate: string | null, status: MatchableRental['status'] = 'FINISHED'): MatchableRental => ({
  _id: new ObjectId(),
  driverId: new ObjectId(),
  startDate,
  endDate,
  status,
});
const at = (date: string, time = '12:00') => zonedDateTimeToUtc(date, time);

describe('matchRental', () => {
  it('identifica com confiança alta a locação que cobre o dia', () => {
    const a = rental('2026-10-01', '2026-10-31');
    const res = matchRental([a, rental('2026-11-01', null, 'ACTIVE')], at('2026-10-15'));
    expect(res.confidence).toBe('HIGH');
    expect(res.rental?._id.equals(a._id)).toBe(true);
  });

  it('23:30 de São Paulo cai no dia local, não no dia UTC seguinte', () => {
    const october = rental('2026-10-01', '2026-10-31');
    const november = rental('2026-11-01', null, 'ACTIVE');
    // 30/10 23:30 BRT = 31/10 02:30 UTC; ainda é 30/10 → locação de outubro, sem ambiguidade.
    const res = matchRental([october, november], at('2026-10-30', '23:30'));
    expect(res.confidence).toBe('HIGH');
    expect(res.rental?._id.equals(october._id)).toBe(true);
  });

  it('dia de troca de motorista fica ambíguo', () => {
    const a = rental('2026-10-01', '2026-10-31');
    const b = rental('2026-10-31', null, 'ACTIVE');
    const res = matchRental([a, b], at('2026-10-31', '10:00'));
    expect(res.confidence).toBe('AMBIGUOUS');
    expect(res.rental).toBeNull();
    expect(res.candidates).toHaveLength(2);
  });

  it('dia de entrega com uma só locação pede confirmação', () => {
    const a = rental('2026-10-10', '2026-10-31');
    expect(matchRental([a], at('2026-10-10')).confidence).toBe('MEDIUM');
    expect(matchRental([a], at('2026-10-31')).confidence).toBe('MEDIUM');
  });

  it('locação sem data de fim cobre o dia', () => {
    const a = rental('2026-09-01', null, 'ACTIVE');
    expect(matchRental([a], at('2026-11-05')).confidence).toBe('HIGH');
  });

  it('ACTIVE passada do fim previsto ainda é do motorista, mas pede confirmação', () => {
    const a = rental('2026-09-01', '2026-10-01', 'ACTIVE');
    const res = matchRental([a], at('2026-10-20'));
    expect(res.confidence).toBe('MEDIUM');
    expect(res.rental?._id.equals(a._id)).toBe(true);
  });

  it('FINISHED usa a data real de devolução', () => {
    const a = rental('2026-09-01', '2026-09-20');
    expect(matchRental([a], at('2026-09-25')).confidence).toBe('NONE');
  });

  it('ignora locação cancelada', () => {
    const a = rental('2026-09-01', '2026-09-30', 'CANCELED');
    expect(matchRental([a], at('2026-09-15')).confidence).toBe('NONE');
  });

  it('sem locação na data → NONE', () => {
    expect(matchRental([], at('2026-09-15'))).toEqual({ confidence: 'NONE', rental: null, candidates: [] });
  });
});
