import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { MongoServerError } from 'mongodb';
import { AppError } from '../common/errors.js';

function zodDetails(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

/** Mapeia a violação de índice único para uma mensagem de negócio. */
function duplicateKeyMessage(err: MongoServerError): string {
  const name = (err as unknown as { message?: string }).message ?? '';
  if (name.includes('uniq_org_plate')) return 'Já existe um veículo com esta placa nesta organização.';
  if (name.includes('uniq_org_renavam')) return 'Já existe um veículo com este Renavam nesta organização.';
  if (name.includes('uniq_org_vin')) return 'Já existe um veículo com este chassi nesta organização.';
  if (name.includes('uniq_org_cpf')) return 'Já existe um motorista com este CPF nesta organização.';
  if (name.includes('uniq_email')) return 'Este e-mail já está cadastrado.';
  if (name.includes('uniq_pending_invite')) return 'Já existe um convite pendente para este e-mail.';
  if (name.includes('uniq_default_account')) return 'Já existe uma conta bancária padrão.';
  if (name.includes('uniq_dedupe') || name.includes('uniq_idempotency'))
    return 'Esta operação já foi registrada anteriormente.';
  if (name.includes('uniq_org_slug')) return 'Já existe uma categoria com este nome.';
  if (name.includes('uniq_org_template_name')) return 'Já existe um template com este nome.';
  if (name.includes('uniq_recurring_period')) return 'A ocorrência recorrente deste período já foi gerada.';
  if (name.includes('uniq_rental_period')) return 'Já existe uma parcela para este contrato e período.';
  if (name.includes('uniq_org_slot_code')) return 'Já existe um tipo de foto com este código.';
  return 'Registro duplicado — verifique os dados informados.';
}

export const errorsPlugin = fp(async function errorsPlugin(app: FastifyInstance) {
  app.setNotFoundHandler((request, reply) => {
    // Rotas do front (Vue Router em modo history): devolve o index.html.
    const sendFile = (reply as unknown as { sendFile?: (name: string) => unknown }).sendFile;
    if (request.method === 'GET' && !request.url.startsWith('/api/') && typeof sendFile === 'function') {
      return sendFile.call(reply, 'index.html');
    }
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'Rota não encontrada.',
        requestId: request.id,
      },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) request.log.error({ err: error }, 'app error');
      else request.log.info({ code: error.code, msg: error.message }, 'handled error');
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          requestId: request.id,
        },
      });
    }

    if (error instanceof ZodError) {
      return reply.status(422).send({
        error: {
          code: 'UNPROCESSABLE',
          message: 'Dados inválidos.',
          details: zodDetails(error),
          requestId: request.id,
        },
      });
    }

    if (error instanceof MongoServerError && Number(error.code) === 11000) {
      return reply.status(409).send({
        error: { code: 'CONFLICT', message: duplicateKeyMessage(error), requestId: request.id },
      });
    }

    const statusCode = Number((error as { statusCode?: number }).statusCode ?? 0);
    if (statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: 'Muitas requisições. Tente novamente em instantes.',
          requestId: request.id,
        },
      });
    }
    if (statusCode === 413) {
      return reply.status(413).send({
        error: { code: 'BAD_REQUEST', message: 'Arquivo acima do limite permitido.', requestId: request.id },
      });
    }
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({
        error: {
          code: statusCode === 401 ? 'UNAUTHORIZED' : statusCode === 403 ? 'FORBIDDEN' : 'BAD_REQUEST',
          message: error.message,
          requestId: request.id,
        },
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL',
        message: 'Erro interno. A equipe foi notificada.',
        requestId: request.id,
      },
    });
  });
});
