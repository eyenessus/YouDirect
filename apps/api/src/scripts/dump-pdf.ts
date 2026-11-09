import { readFileSync } from 'node:fs';
import { extractPdfText } from '../pdf/extract.js';
const file = process.argv[2]!;
const minY = Number(process.argv[3] ?? '0');
const maxY = Number(process.argv[4] ?? '1000');
const page = Number(process.argv[5] ?? '1');
const items = extractPdfText(readFileSync(file));
for (const it of items.filter((i) => i.page === page).sort((a, b) => b.y - a.y || a.x - b.x)) {
  if (it.y >= minY && it.y <= maxY) {
    console.log(`${it.x.toFixed(1)}\t${it.y.toFixed(1)}\t${it.size}\t${JSON.stringify(it.text)}`);
  }
}
