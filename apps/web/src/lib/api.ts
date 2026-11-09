import type { ApiError } from '@yudirect/contracts';

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api/v1';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId?: string;

  constructor(status: number, payload: ApiError['error']) {
    super(payload.message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = payload.code;
    this.details = payload.details;
    this.requestId = payload.requestId;
  }

  /** Mensagens por campo, prontas para exibir no formulário. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.details)) {
      for (const issue of this.details as Array<{ path?: string; message?: string }>) {
        if (issue?.path) out[issue.path] = issue.message ?? 'Valor inválido';
      }
    }
    return out;
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  raw?: boolean;
}

function buildUrl(path: string, query?: Query): string {
  const url = `${BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const isForm = options.body instanceof FormData;
  const response = await fetch(buildUrl(path, options.query), {
    method,
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...(isForm || options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    body: isForm ? (options.body as FormData) : options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  if (response.status === 401 && path !== '/auth/me' && path !== '/auth/login') {
    onUnauthorized?.();
  }

  if (!response.ok) {
    let payload: ApiError['error'] = {
      code: 'INTERNAL',
      message: `Falha na requisição (HTTP ${response.status}).`,
    };
    try {
      const json = (await response.json()) as ApiError;
      if (json?.error) payload = json.error;
    } catch {
      /* resposta sem corpo JSON */
    }
    throw new ApiRequestError(response.status, payload);
  }

  if (options.raw) return response as unknown as T;
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, { ...options, body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, { ...options, body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, { ...options, body }),
  delete: <T>(path: string, options?: RequestOptions) => request<T>('DELETE', path, options),
};

/** Faz o download de um arquivo gerado pela API respeitando a sessão. */
export async function downloadFile(path: string, fallbackName: string, query?: Query): Promise<void> {
  const response = await fetch(buildUrl(path, query), {
    credentials: 'include',
    headers: { accept: 'application/octet-stream' },
  });
  if (!response.ok) {
    let message = `Não foi possível gerar o arquivo (HTTP ${response.status}).`;
    try {
      const json = (await response.json()) as ApiError;
      if (json?.error?.message) message = json.error.message;
    } catch {
      /* ignore */
    }
    throw new ApiRequestError(response.status, { code: 'INTERNAL', message });
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = match?.[1] ?? fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export interface UploadedFileResponse {
  id: string;
  url: string;
  contentType: string;
  size: number;
  originalName: string;
}

export async function uploadFile(file: File, purpose: string): Promise<UploadedFileResponse> {
  const form = new FormData();
  form.append('purpose', purpose);
  form.append('file', file);
  return request<UploadedFileResponse>('POST', '/files', { body: form });
}
