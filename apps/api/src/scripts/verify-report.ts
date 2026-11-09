#!/usr/bin/env tsx
/**
 * Compara o PDF gerado pela aplicação com o golden master fornecido
 * (`manutencoes-ebr7g53-2026-11-08.pdf`): número de páginas, conteúdo
 * textual e posição (x, y) de cada fragmento.
 *
 * Uso:  npm run report:verify -w @frotaone/api -- <caminho-do-golden.pdf>
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { goldenMaintenanceReportFixture } from '../testing/golden-report-fixture.js';
import { renderMaintenanceReport } from '../pdf/maintenance-report.js';
import { extractPdfText, groupLines, pageCount, type ExtractedItem } from '../pdf/extract.js';

function normalize(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function match(golden: ExtractedItem[], generated: ExtractedItem[]) {
  const used = new Set<number>();
  const rows: Array<{ text: string; gx: number; gy: number; mx: number | null; my: number | null }> = [];
  for (const g of golden) {
    const target = normalize(g.text);
    let bestIdx = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    generated.forEach((c, idx) => {
      if (used.has(idx)) return;
      if (normalize(c.text) !== target) return;
      if (c.page !== g.page) return;
      const score = Math.abs(c.x - g.x) + Math.abs(c.y - g.y);
      if (score < bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    });
    if (bestIdx >= 0) {
      used.add(bestIdx);
      rows.push({ text: target, gx: g.x, gy: g.y, mx: generated[bestIdx]!.x, my: generated[bestIdx]!.y });
    } else {
      rows.push({ text: target, gx: g.x, gy: g.y, mx: null, my: null });
    }
  }
  return rows;
}

async function main() {
  const goldenPath = process.argv[2] ?? resolve(process.cwd(), '../../../manutencoes-ebr7g53-2026-11-08.pdf');
  const goldenBuffer = await readFile(goldenPath);

  const generated = await renderMaintenanceReport(goldenMaintenanceReportFixture());
  const outPath = resolve(process.cwd(), 'tmp-maintenance-report.pdf');
  await writeFile(outPath, generated);

  const goldenItems = extractPdfText(goldenBuffer);
  const generatedItems = extractPdfText(generated);

  const rows = match(goldenItems, generatedItems);
  const matched = rows.filter((r) => r.mx !== null);
  const missing = rows.filter((r) => r.mx === null);
  const dx = matched.map((r) => Math.abs(r.mx! - r.gx));
  const dy = matched.map((r) => Math.abs(r.my! - r.gy));
  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const max = (arr: number[]) => (arr.length ? Math.max(...arr) : 0);

  const goldenLines = groupLines(goldenItems);
  const generatedLines = groupLines(generatedItems);

  console.log('='.repeat(72));
  console.log('VERIFICAÇÃO DO RELATÓRIO DE MANUTENÇÕES (golden master)');
  console.log('='.repeat(72));
  console.log(`Golden    : ${goldenPath}`);
  console.log(`Gerado    : ${outPath}`);
  console.log(`Páginas   : golden=${pageCount(goldenBuffer)}  gerado=${pageCount(generated)}`);
  console.log(`Fragmentos: golden=${goldenItems.length}  gerado=${generatedItems.length}`);
  console.log(
    `Texto     : ${matched.length}/${rows.length} fragmentos encontrados (${(
      (matched.length / rows.length) * 100
    ).toFixed(1)}%)`,
  );
  console.log(`Δx        : média ${avg(dx).toFixed(2)} pt | máx ${max(dx).toFixed(2)} pt`);
  console.log(`Δy        : média ${avg(dy).toFixed(2)} pt | máx ${max(dy).toFixed(2)} pt`);

  if (missing.length > 0) {
    console.log('\nFragmentos do golden não encontrados no PDF gerado:');
    for (const row of missing.slice(0, 40)) {
      console.log(`  - "${row.text}" (x=${row.gx.toFixed(1)} y=${row.gy.toFixed(1)})`);
    }
    if (missing.length > 40) console.log(`  … e mais ${missing.length - 40}.`);
  }

  const worst = [...matched]
    .sort((a, b) => Math.abs(b.my! - b.gy) - Math.abs(a.my! - a.gy))
    .slice(0, 15);
  console.log('\nMaiores divergências verticais:');
  for (const row of worst) {
    console.log(
      `  "${row.text.slice(0, 44).padEnd(44)}" golden(y=${row.gy.toFixed(1)}) gerado(y=${row.my!.toFixed(
        1,
      )}) Δ=${Math.abs(row.my! - row.gy).toFixed(1)}`,
    );
  }

  console.log('\nLinhas (golden → gerado):');
  const maxLines = Math.max(goldenLines.length, generatedLines.length);
  for (let i = 0; i < maxLines; i++) {
    const a = goldenLines[i] ?? '';
    const b = generatedLines[i] ?? '';
    const flag = normalize(a) === normalize(b) ? ' ' : '!';
    console.log(`${flag} ${String(i + 1).padStart(3)} | ${a.slice(0, 60).padEnd(60)} | ${b.slice(0, 60)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
