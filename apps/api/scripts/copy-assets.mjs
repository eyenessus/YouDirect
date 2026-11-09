import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Copia assets estáticos (logotipo usado nos PDFs) para o build.
const here = dirname(fileURLToPath(import.meta.url));
const from = resolve(here, '../src/assets');
const to = resolve(here, '../dist/assets');
await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
console.log(`assets copiados para ${to}`);
