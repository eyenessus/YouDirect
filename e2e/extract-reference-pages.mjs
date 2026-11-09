/**
 * Extrai as páginas do PDF de capturas de referência como PNGs, na
 * resolução original, para diff visual lado a lado contra as telas
 * geradas por `e2e/capture-screens.mjs`.
 *
 *   node e2e/extract-reference-pages.mjs <arquivo.pdf> [destino]
 *
 * O PDF de referência é um conjunto de screenshots: há exatamente um
 * XObject de imagem por página. Como streams não podem ficar dentro de
 * object streams comprimidos (`/ObjStm`), varremos os objetos de imagem
 * diretamente, na ordem em que aparecem no arquivo — isso dispensa
 * interpretar a árvore de páginas e a tabela xref cruzada.
 *
 * As imagens são copiadas/recodificadas sem reamostragem: nenhuma perda
 * de resolução em relação à referência.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { deflateSync, inflateSync } from 'node:zlib';
import { join, resolve } from 'node:path';

const [, , pdfArg, outArg] = process.argv;

if (!pdfArg) {
  console.error('Uso: node e2e/extract-reference-pages.mjs <arquivo.pdf> [destino]');
  process.exit(1);
}

const pdfPath = resolve(process.cwd(), pdfArg);
const outDir = resolve(process.cwd(), outArg ?? '.cache/reference');

/* ----------------------------- PNG mínimo -------------------------- */

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Monta um PNG a partir de amostras cruas (1, 3 ou 4 canais, 8 bits). */
function buildPng(width, height, channels, raw) {
  const colorType = { 1: 0, 3: 2, 4: 6 }[channels];
  if (colorType === undefined) throw new Error(`canais não suportados: ${channels}`);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;

  // PNG exige o byte de filtro (0 = None) no início de cada linha.
  const stride = width * channels;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    scanlines[y * (stride + 1)] = 0;
    raw.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------- varredura do PDF ----------------------- */

function findImageObjects(buf) {
  const text = buf.toString('latin1');
  const images = [];
  const re = /(\d+)\s+0\s+obj/g;
  let match;
  while ((match = re.exec(text))) {
    const headerEnd = re.lastIndex;
    const endObj = text.indexOf('endobj', headerEnd);
    const streamIdx = text.indexOf('stream', headerEnd);
    if (streamIdx < 0 || endObj < 0 || streamIdx > endObj) continue;

    const dict = text.slice(headerEnd, streamIdx);
    if (!/\/Subtype\s*\/Image/.test(dict)) continue;
    if (/\/ImageMask\s+true/.test(dict)) continue; // máscaras não são páginas

    const length = Number(/\/Length\s+(\d+)/.exec(dict)?.[1] ?? 0);
    if (!length) continue;

    let start = streamIdx + 'stream'.length;
    if (text[start] === '\r') start += 1;
    if (text[start] === '\n') start += 1;

    images.push({
      objectNumber: Number(match[1]),
      width: Number(/\/Width\s+(\d+)/.exec(dict)?.[1] ?? 0),
      height: Number(/\/Height\s+(\d+)/.exec(dict)?.[1] ?? 0),
      bits: Number(/\/BitsPerComponent\s+(\d+)/.exec(dict)?.[1] ?? 8),
      colorSpace: /\/ColorSpace\s*\/(\w+)/.exec(dict)?.[1] ?? '',
      filter: /\/Filter\s*\/(\w+)/.exec(dict)?.[1] ?? '',
      data: buf.subarray(start, start + length),
    });
  }
  return images.sort((a, b) => a.objectNumber - b.objectNumber);
}

const channelsByColorSpace = { DeviceRGB: 3, DeviceGray: 1, DeviceCMYK: 4 };

async function main() {
  const buf = await readFile(pdfPath);
  const images = findImageObjects(buf);

  if (images.length === 0) {
    console.error('Nenhum XObject de imagem encontrado neste PDF.');
    process.exit(2);
  }

  await mkdir(outDir, { recursive: true });

  let written = 0;
  const skipped = [];

  for (const [index, image] of images.entries()) {
    const label = String(index + 1).padStart(3, '0');

    if (image.filter === 'DCTDecode') {
      // JPEG já embutido: cópia byte a byte.
      await writeFile(join(outDir, `page${label}.jpg`), image.data);
      written += 1;
      continue;
    }

    if (image.filter !== 'FlateDecode' || image.bits !== 8 || !image.width || !image.height) {
      // Nada é convertido às cegas: grava cru e avisa.
      await writeFile(
        join(outDir, `page${label}.${(image.filter || 'bin').toLowerCase()}`),
        image.data,
      );
      skipped.push(`página ${label}: filtro ${image.filter || '—'} gravado sem conversão`);
      written += 1;
      continue;
    }

    const raw = inflateSync(image.data);
    const expected = channelsByColorSpace[image.colorSpace];
    const channels = expected ?? raw.length / (image.width * image.height);

    if (channels === 4 && image.colorSpace === 'DeviceCMYK') {
      skipped.push(`página ${label}: CMYK não convertido para PNG`);
      await writeFile(join(outDir, `page${label}.cmyk.bin`), raw);
      written += 1;
      continue;
    }

    await writeFile(
      join(outDir, `page${label}.png`),
      buildPng(image.width, image.height, channels, raw),
    );
    written += 1;
  }

  console.log(`${written} página(s) extraída(s) para ${outDir}`);
  for (const warning of skipped) console.warn(`  aviso: ${warning}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
