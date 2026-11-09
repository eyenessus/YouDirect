#!/usr/bin/env tsx
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { openApiDocument } from '../openapi.js';

const target = resolve(process.cwd(), '../../docs/openapi.json');
const doc = openApiDocument(process.env.API_PUBLIC_URL ?? 'http://localhost:3333');
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
console.log(`OpenAPI exportado para ${target}`);
