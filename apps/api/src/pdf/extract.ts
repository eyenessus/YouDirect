import { inflateSync } from 'node:zlib';

/* ------------------------------------------------------------------ *
 * Extrator mínimo de texto posicionado de PDFs gerados por pdfmake.
 * Usado para comparar objetivamente o PDF gerado com o golden master
 * (teste T09) — não é um parser completo de PDF.
 * ------------------------------------------------------------------ */

export interface ExtractedItem {
  page: number;
  x: number;
  y: number;
  size: number;
  text: string;
}

interface RawObject {
  dict: string;
  data: Buffer | null;
}

function indexObjects(buf: Buffer): Map<string, RawObject> {
  const s = buf.toString('latin1');
  const out = new Map<string, RawObject>();
  const re = /(\d+)\s+(\d+)\s+obj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const num = m[1]!;
    const hdrEnd = re.lastIndex;
    const endIdx = s.indexOf('endobj', hdrEnd);
    if (endIdx < 0) continue;
    const streamIdx = s.indexOf('stream', hdrEnd);
    const hasStream = streamIdx > 0 && streamIdx < endIdx;
    const dict = s.slice(hdrEnd, hasStream ? streamIdx : endIdx);
    let data: Buffer | null = null;
    if (hasStream) {
      const lm = /\/Length\s+(\d+)/.exec(dict);
      if (lm) {
        let ds = streamIdx + 6;
        if (s[ds] === '\r') ds++;
        if (s[ds] === '\n') ds++;
        data = buf.subarray(ds, ds + Number(lm[1]));
        if (/FlateDecode/.test(dict)) {
          try {
            data = inflateSync(data);
          } catch {
            data = null;
          }
        }
      }
    }
    out.set(num, { dict, data });
  }
  return out;
}

function hexToStr(h: string): string {
  let out = '';
  for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.substr(i, 4), 16));
  return out;
}

function parseToUnicode(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  let m: RegExpExecArray | null;

  const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = charRe.exec(text))) {
    const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let p: RegExpExecArray | null;
    while ((p = pairRe.exec(m[1]!))) map[p[1]!.toUpperCase().padStart(4, '0')] = hexToStr(p[2]!);
  }

  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = rangeRe.exec(text))) {
    const body = m[1]!;
    const rRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[([\s\S]*?)\]|<([0-9A-Fa-f]+)>)/g;
    let p: RegExpExecArray | null;
    while ((p = rRe.exec(body))) {
      const a = parseInt(p[1]!, 16);
      const b = parseInt(p[2]!, 16);
      const key = (i: number) => i.toString(16).toUpperCase().padStart(4, '0');
      if (p[4] !== undefined) {
        const arr: string[] = [];
        const ar = /<([0-9A-Fa-f\s]+)>/g;
        let q: RegExpExecArray | null;
        while ((q = ar.exec(p[4]!))) arr.push(hexToStr(q[1]!.replace(/\s+/g, '')));
        for (let i = a; i <= b && i - a < arr.length; i++) map[key(i)] = arr[i - a]!;
      } else {
        const c = parseInt(p[5]!, 16);
        for (let i = a; i <= b; i++) map[key(i)] = String.fromCharCode(c + (i - a));
      }
    }
  }
  return map;
}

export function extractPdfText(buf: Buffer): ExtractedItem[] {
  const objects = indexObjects(buf);
  const fontMaps = new Map<string, Record<string, string>>();
  for (const [num, obj] of objects) {
    if (!/\/Type\s*\/Font/.test(obj.dict)) continue;
    const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(obj.dict);
    if (!tu) continue;
    const cmap = objects.get(tu[1]!);
    if (cmap?.data) fontMaps.set(num, parseToUnicode(cmap.data.toString('latin1')));
  }

  const pages: Array<{ content: string[]; aliases: Record<string, string> }> = [];
  for (const [, obj] of objects) {
    if (!/\/Type\s*\/Page\b/.test(obj.dict)) continue;
    const contentRefs: string[] = [];
    const single = /\/Contents\s+(\d+)\s+0\s+R/.exec(obj.dict);
    if (single) contentRefs.push(single[1]!);
    const array = /\/Contents\s*\[([^\]]*)\]/.exec(obj.dict);
    if (array) {
      const refRe = /(\d+)\s+0\s+R/g;
      let r: RegExpExecArray | null;
      while ((r = refRe.exec(array[1]!))) contentRefs.push(r[1]!);
    }
    const resRef = /\/Resources\s+(\d+)\s+0\s+R/.exec(obj.dict);
    const resDict = resRef ? (objects.get(resRef[1]!)?.dict ?? '') : obj.dict;
    const aliases: Record<string, string> = {};
    const fre = /\/(F\d+)\s+(\d+)\s+0\s+R/g;
    let fm: RegExpExecArray | null;
    while ((fm = fre.exec(resDict))) aliases[fm[1]!] = fm[2]!;
    pages.push({ content: contentRefs, aliases });
  }

  const items: ExtractedItem[] = [];
  pages.forEach((page, pageIndex) => {
    const text = page.content
      .map((ref) => objects.get(ref)?.data?.toString('latin1') ?? '')
      .join('\n');
    const blockRe = /BT\s*([\s\S]*?)\s*ET/g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(text))) {
      const block = m[1]!;
      const tm = /([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm/.exec(block);
      const tf = /\/(F\d+)\s+([\d.]+)\s+Tf/.exec(block);
      const map = tf ? (fontMaps.get(page.aliases[tf[1]!] ?? '') ?? {}) : {};
      let out = '';
      const showRe = /\[[\s\S]*?\]\s*TJ|<[0-9A-Fa-f]+>\s*Tj/g;
      let sm: RegExpExecArray | null;
      while ((sm = showRe.exec(block))) {
        const gr = /<([0-9A-Fa-f]+)>/g;
        let g: RegExpExecArray | null;
        while ((g = gr.exec(sm[0]))) {
          const hex = g[1]!;
          for (let i = 0; i + 4 <= hex.length; i += 4) {
            const code = hex.substr(i, 4).toUpperCase();
            out += map[code] ?? '�';
          }
        }
      }
      if (!out.trim()) continue;
      items.push({
        page: pageIndex + 1,
        x: tm ? Number(tm[5]) : 0,
        y: tm ? Number(tm[6]) : 0,
        size: tf ? Number(tf[2]) : 0,
        text: out,
      });
    }
  });
  return items;
}

/** Agrupa os itens em linhas lógicas (tolerância vertical em pontos). */
export function groupLines(items: ExtractedItem[], tolerance = 2): string[] {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines: string[] = [];
  let currentY: number | null = null;
  let currentPage = -1;
  let buffer: string[] = [];
  for (const item of sorted) {
    if (currentY === null || item.page !== currentPage || Math.abs(item.y - currentY) > tolerance) {
      if (buffer.length) lines.push(buffer.join(' ').replace(/\s+/g, ' ').trim());
      buffer = [];
      currentY = item.y;
      currentPage = item.page;
    }
    buffer.push(item.text);
  }
  if (buffer.length) lines.push(buffer.join(' ').replace(/\s+/g, ' ').trim());
  return lines;
}

/** Texto plano normalizado, útil para asserções de conteúdo. */
export function extractPlainText(buf: Buffer): string {
  return groupLines(extractPdfText(buf)).join('\n');
}

export function pageCount(buf: Buffer): number {
  const s = buf.toString('latin1');
  const matches = s.match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : 0;
}
