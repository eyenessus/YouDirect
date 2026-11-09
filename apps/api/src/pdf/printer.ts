import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { TDocumentDefinitions } from 'pdfmake/interfaces.js';

const require = createRequire(import.meta.url);

/* ------------------------------------------------------------------ *
 * Geração de PDF.
 *
 * O PDF de referência (golden master) foi produzido com pdfmake e
 * embute Roboto-Regular e Roboto-Medium (confirmado pelos descritores
 * `/BaseFont /BZZZZZ+Roboto-Medium` e `/CZZZZZ+Roboto-Regular`).
 * Usamos exatamente as mesmas famílias, carregadas do VFS do pdfmake.
 * ------------------------------------------------------------------ */

let printerPromise: Promise<unknown> | null = null;

function loadVfsFonts(): Record<string, Buffer> {
  const mod = require('pdfmake/build/vfs_fonts.js') as Record<string, unknown>;
  const raw = ((mod as { default?: unknown }).default ?? mod) as Record<string, unknown>;
  const table = ((raw as { pdfMake?: { vfs: Record<string, string> } }).pdfMake?.vfs ??
    raw) as Record<string, string>;
  const out: Record<string, Buffer> = {};
  for (const [name, b64] of Object.entries(table)) {
    if (typeof b64 === 'string') out[name] = Buffer.from(b64, 'base64');
  }
  return out;
}

async function getPrinter() {
  if (!printerPromise) {
    printerPromise = (async () => {
      const PdfPrinter = require('pdfmake/src/printer.js') as new (fonts: unknown) => unknown;
      const vfs = loadVfsFonts();
      return new PdfPrinter({
        Roboto: {
          normal: vfs['Roboto-Regular.ttf'],
          bold: vfs['Roboto-Medium.ttf'],
          italics: vfs['Roboto-Italic.ttf'],
          bolditalics: vfs['Roboto-MediumItalic.ttf'],
        },
      });
    })();
  }
  return printerPromise;
}

export async function renderPdf(definition: TDocumentDefinitions): Promise<Buffer> {
  const printer = (await getPrinter()) as {
    createPdfKitDocument: (d: TDocumentDefinitions) => NodeJS.ReadableStream & { end: () => void };
  };
  const doc = printer.createPdfKitDocument(definition);
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

let logoCache: string | null = null;

/** Logotipo FrotaOne em data URI (mesmo asset do PDF de referência). */
export async function brandLogoDataUri(): Promise<string> {
  if (logoCache) return logoCache;
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, '..', 'assets', 'frotaone-logo.png');
  const buffer = await readFile(file);
  logoCache = `data:image/png;base64,${buffer.toString('base64')}`;
  return logoCache;
}

/* ------------------------- Tokens do documento --------------------- */

export const PDF_COLORS = {
  title: '#0B1F3A',
  text: '#1F2937',
  muted: '#334155',
  border: '#E2E8F0',
  zebra: '#F8FAFC',
  positive: '#0F766E',
  negative: '#B91C1C',
} as const;

export const PAGE = {
  width: 595.28,
  height: 841.89,
  marginLeft: 36,
  marginRight: 36,
  marginTop: 90,
  marginBottom: 40,
  get contentWidth() {
    return this.width - this.marginLeft - this.marginRight;
  },
} as const;

/* ------------------------------------------------------------------ *
 * Geometria calibrada a partir do golden master.
 *
 * Atenção: em pdfmake a largura declarada em `widths` é a largura do
 * CONTEÚDO — o padding horizontal do layout é somado a ela. As medidas
 * abaixo já descontam o padding, de modo que as colunas caiam nas
 * mesmas coordenadas do PDF de referência.
 * ------------------------------------------------------------------ */

export const TABLE_PAD = 8;
export const PAIR_PAD = 10.2;

/** Tabelas com cabeçalho e linhas divisórias (histórico, peças, grupos). */
export const tableLayout = {
  hLineWidth: () => 0.4,
  vLineWidth: () => 0,
  hLineColor: () => PDF_COLORS.border,
  paddingLeft: () => TABLE_PAD,
  paddingRight: () => TABLE_PAD,
  paddingTop: () => 5.4,
  paddingBottom: () => 5.4,
  fillColor: (rowIndex: number) => (rowIndex % 2 === 1 ? PDF_COLORS.zebra : null),
};

/** Tabelas rótulo/valor em pares (identificação e detalhe da OS). */
export const pairLayout = {
  hLineWidth: () => 0,
  vLineWidth: () => 0,
  paddingLeft: () => PAIR_PAD,
  paddingRight: () => PAIR_PAD,
  paddingTop: () => 6.2,
  paddingBottom: () => 6.2,
  fillColor: (rowIndex: number) => (rowIndex % 2 === 1 ? PDF_COLORS.zebra : null),
};

/** Blocos de métricas sem divisórias (Resumo e Total da OS). */
export const plainLayout = {
  hLineWidth: () => 0,
  vLineWidth: () => 0,
  paddingLeft: () => TABLE_PAD,
  paddingRight: () => TABLE_PAD,
  paddingTop: () => 5.7,
  paddingBottom: () => 5.7,
  fillColor: (rowIndex: number) => (rowIndex % 2 === 1 ? PDF_COLORS.zebra : null),
};

/** Larguras de conteúdo medidas no golden master (em pontos). */
export const COLUMNS = {
  /** Identificação do veículo / detalhe da OS: rótulo|valor|rótulo|valor. */
  pair: [56, 164.6, 56, 165.08],
  /** Histórico consolidado: OS, Tipo, Situação, Abertura, Execução, KM, Total. */
  history: [42.4, 50.4, 64.4, 44.4, 44.4, 40.4, 122.48],
  /** Por tipo / Por situação: Grupo, Quantidade, Custo. */
  group: ['*', 92, 80.08] as Array<number | string>,
  /** Peças e itens: Peça, Qtd, Unitário, Fornecedor, Garantia até, Próxima. */
  items: [197, 20.56, 42.74, 61.7, 55, 50.08],
  /** Total da OS: rótulo (flex) + valor. */
  total: ['*', 103.08] as Array<number | string>,
} as const;
