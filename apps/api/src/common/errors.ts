import type { ApiErrorCode } from '@frotaone/contracts';

const statusByCode: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  INTEGRATION_UNAVAILABLE: 503,
};

export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusByCode[code];
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError('BAD_REQUEST', message, details);
export const unauthorized = (message = 'Sessão inválida ou expirada.') =>
  new AppError('UNAUTHORIZED', message);
export const forbidden = (message = 'Você não tem permissão para esta ação.') =>
  new AppError('FORBIDDEN', message);
export const notFound = (message = 'Registro não encontrado.') => new AppError('NOT_FOUND', message);
export const conflict = (message: string, details?: unknown) => new AppError('CONFLICT', message, details);
export const unprocessable = (message: string, details?: unknown) =>
  new AppError('UNPROCESSABLE', message, details);
export const integrationUnavailable = (message: string, details?: unknown) =>
  new AppError('INTEGRATION_UNAVAILABLE', message, details);
