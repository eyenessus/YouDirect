/**
 * Mede geometria em PNGs de tela — usado para comparar objetivamente as
 * capturas da aplicação com as páginas da referência, sem depender de
 * inspeção visual.
 *
 *   node e2e/measure-screens.mjs rows   <png> [--chrome 48] [--scale 1.2] [--x 1700]
 *   node e2e/measure-screens.mjs cols   <png> --y0 583 --y1 592 [--x0 140] [--x1 1880]
 *   node e2e/measure-screens.mjs bands  <png> --y0 164 --y1 315 [--x0 150] [--x1 720]
 *
 * - `rows`  lista as transições de cor ao longo de uma coluna vertical
 *           (bordas de cartões, inputs, linhas de tabela).
 * - `cols`  lista os intervalos horizontais ocupados por texto numa
 *           faixa de linhas (revela o alinhamento de cada coluna).
 * - `bands` lista as faixas verticais com texto (linhas de um bloco).
 *
 * `--chrome` desconta a altura da moldura do navegador presente nas
 * capturas de referência; `--scale` converte px de imagem em px CSS
 * (as referências foram feitas com zoom de 120%).
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const [, , mode, file, ...rest] = process.argv;

if (!mode || !file) {
  console.error('Uso: node e2e/measure-screens.mjs <rows|cols|bands> <arquivo.png> [opções]');
  process.exit(1);
}

const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? Number(rest[i + 1]) : fallback;
};

/* ----------------------- decodificador de PNG ---------------------- */

function decodePng(buf) {
  let pos = 8;
  let width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

const img = decodePng(readFileSync(file));
const { width, height, channels, data } = img;
const rgb = (x, y) => {
  const i = (y * width + x) * channels;
  return [data[i], data[i + 1], data[i + 2]];
};
const isDark = (x, y) => {
  const [r, g] = rgb(x, y);
  return r < 170 && g < 170;
};

const chrome = opt('chrome', 0);
const scale = opt('scale', 1);
const toCss = (y) => ((y - chrome) / scale).toFixed(1);

if (mode === 'rows') {
  const x = opt('x', Math.round(width * 0.45));
  const y0 = opt('y0', chrome + 1);
  const y1 = opt('y1', height - 1);
  const marks = [];
  for (let y = y0 + 1; y <= y1; y += 1) {
    const a = rgb(x, y - 1);
    const b = rgb(x, y);
    if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 10) {
      marks.push(`${y}(css ${toCss(y)})`);
    }
  }
  console.log(`transições em x=${x}:`);
  console.log('  ' + (marks.join(' ') || '(nenhuma)'));
} else if (mode === 'cols') {
  const y0 = opt('y0', 0);
  const y1 = opt('y1', height - 1);
  const x0 = opt('x0', 0);
  const x1 = opt('x1', width - 1);
  const runs = [];
  let run = null;
  for (let x = x0; x <= x1; x += 1) {
    let n = 0;
    for (let y = y0; y <= y1; y += 1) if (isDark(x, y)) n += 1;
    if (n > 0) {
      if (!run) run = { a: x, b: x };
      else run.b = x;
    } else if (run) {
      if (run.b - run.a >= 1) runs.push(run);
      run = null;
    }
  }
  if (run) runs.push(run);
  // Agrupa fragmentos próximos (letras da mesma palavra/coluna).
  const groups = [];
  for (const r of runs) {
    const last = groups[groups.length - 1];
    if (last && r.a - last.b <= 12) last.b = r.b;
    else groups.push({ ...r });
  }
  console.log(`colunas de texto em y ${y0}..${y1}:`);
  console.log('  ' + groups.map((g) => `${g.a}..${g.b}`).join('  '));
} else if (mode === 'bands') {
  const x0 = opt('x0', 0);
  const x1 = opt('x1', width - 1);
  const y0 = opt('y0', 0);
  const y1 = opt('y1', height - 1);
  const bands = [];
  let run = null;
  for (let y = y0; y <= y1; y += 1) {
    let n = 0;
    for (let x = x0; x <= x1; x += 1) if (isDark(x, y)) n += 1;
    if (n >= 2) {
      if (!run) run = { a: y, b: y };
      else run.b = y;
    } else if (run) {
      bands.push(run);
      run = null;
    }
  }
  if (run) bands.push(run);
  console.log(`faixas de texto em x ${x0}..${x1}:`);
  for (const b of bands) {
    console.log(`  img ${b.a}..${b.b}   css ${toCss(b.a)}..${toCss(b.b)}`);
  }
} else {
  console.error(`Modo desconhecido: ${mode}`);
  process.exit(1);
}
