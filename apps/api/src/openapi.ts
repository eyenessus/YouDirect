/* ------------------------------------------------------------------ *
 * Documento OpenAPI 3.1 da API YuDirect.
 * Mantido manualmente junto às rotas — `npm run openapi` exporta para
 * docs/openapi.json.
 * ------------------------------------------------------------------ */

type Operation = Record<string, unknown>;

const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const errorResponses = {
  '400': { description: 'Requisição inválida', ...json(ref('ApiError')) },
  '401': { description: 'Não autenticado', ...json(ref('ApiError')) },
  '403': { description: 'Sem permissão', ...json(ref('ApiError')) },
  '404': { description: 'Não encontrado', ...json(ref('ApiError')) },
  '409': { description: 'Conflito de regra de negócio', ...json(ref('ApiError')) },
  '422': { description: 'Dados inválidos', ...json(ref('ApiError')) },
  '429': { description: 'Limite de requisições excedido', ...json(ref('ApiError')) },
};

function op(
  summary: string,
  tag: string,
  extra: Operation = {},
): Operation {
  return {
    summary,
    tags: [tag],
    responses: { '200': { description: 'OK' }, ...errorResponses },
    ...extra,
  };
}

const pathParam = (name: string, description: string) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string' },
});

export function openApiDocument(serverUrl: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'YuDirect API',
      version: '1.0.0',
      description:
        'API da plataforma YuDirect (gestão de frota, locações, manutenções, vistorias e financeiro). ' +
        'Autenticação por sessão opaca em cookie HttpOnly. Todos os recursos são isolados por organização. ' +
        'Valores monetários são inteiros em centavos; datas de negócio usam o formato AAAA-MM-DD.',
    },
    servers: [{ url: `${serverUrl.replace(/\/$/, '')}/api/v1` }],
    tags: [
      { name: 'Autenticação' },
      { name: 'Perfil' },
      { name: 'Arquivos' },
      { name: 'Veículos' },
      { name: 'Motoristas' },
      { name: 'Locações' },
      { name: 'Manutenções' },
      { name: 'Vistorias' },
      { name: 'Financeiro' },
      { name: 'Relatórios' },
      { name: 'Notificações' },
      { name: 'Organização' },
    ],
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'yudirect_session' },
      },
      schemas: {
        ApiError: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: {
                  type: 'string',
                  enum: [
                    'BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT',
                    'UNPROCESSABLE', 'RATE_LIMITED', 'INTERNAL', 'INTEGRATION_UNAVAILABLE',
                  ],
                },
                message: { type: 'string' },
                details: {},
                requestId: { type: 'string' },
              },
            },
          },
        },
        AmountCents: { type: 'integer', description: 'Valor em centavos inteiros', minimum: 0 },
        IsoDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        PageMeta: {
          type: 'object',
          properties: { nextCursor: { type: ['string', 'null'] }, total: { type: 'integer' } },
        },
      },
    },
    security: [{ sessionCookie: [] }],
    paths: {
      '/auth/login': {
        post: op('Autentica e cria a sessão (cookie HttpOnly)', 'Autenticação', {
          security: [],
          requestBody: json({
            type: 'object',
            required: ['email', 'password'],
            properties: {
              email: { type: 'string', format: 'email' },
              password: { type: 'string' },
              organizationId: { type: 'string' },
            },
          }),
        }),
      },
      '/auth/me': { get: op('Sessão atual: usuário, organização e permissões', 'Autenticação') },
      '/auth/logout': { post: op('Revoga a sessão atual', 'Autenticação') },
      '/auth/password/change': {
        post: op('Altera a senha e revoga as demais sessões', 'Autenticação', {
          requestBody: json({
            type: 'object',
            required: ['currentPassword', 'newPassword', 'confirmPassword'],
            properties: {
              currentPassword: { type: 'string' },
              newPassword: { type: 'string', minLength: 6 },
              confirmPassword: { type: 'string', minLength: 6 },
            },
          }),
        }),
      },
      '/profile': {
        get: op('Dados do perfil', 'Perfil'),
        patch: op('Atualiza nome e telefone', 'Perfil'),
      },
      '/profile/notification-preferences': {
        patch: op('Ativa/desativa notificações do navegador', 'Perfil'),
      },
      '/invitations/{token}': {
        get: op('Dados públicos do convite', 'Organização', {
          security: [],
          parameters: [pathParam('token', 'Token do convite')],
        }),
      },
      '/invitations/accept': {
        post: op('Aceita o convite e cria a sessão', 'Organização', { security: [] }),
      },

      '/files': {
        post: op('Envia um arquivo (multipart: file + purpose)', 'Arquivos', {
          requestBody: {
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file', 'purpose'],
                  properties: {
                    file: { type: 'string', format: 'binary' },
                    purpose: {
                      type: 'string',
                      enum: [
                        'VEHICLE_PHOTO', 'DRIVER_ID', 'DRIVER_ADDRESS_PROOF',
                        'RENTAL_CONTRACT', 'MAINTENANCE_INVOICE', 'INSPECTION_PHOTO',
                      ],
                    },
                  },
                },
              },
            },
          },
        }),
      },
      '/files/{id}/content': {
        get: op('Conteúdo do arquivo via URL assinada (sig/exp/org)', 'Arquivos', {
          security: [],
          parameters: [pathParam('id', 'ID do arquivo')],
        }),
      },
      '/files/{id}/access-url': {
        get: op('Gera nova URL assinada', 'Arquivos', { parameters: [pathParam('id', 'ID do arquivo')] }),
      },
      '/files/{id}': {
        delete: op('Exclusão lógica do arquivo', 'Arquivos', { parameters: [pathParam('id', 'ID')] }),
      },

      '/vehicles': {
        get: op('Lista veículos (busca por placa, marca, modelo, cor)', 'Veículos', {
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' } },
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
          ],
        }),
        post: op('Cadastra veículo', 'Veículos'),
      },
      '/vehicles/{id}': {
        get: op('Detalhe do veículo', 'Veículos', { parameters: [pathParam('id', 'ID')] }),
        patch: op('Atualiza veículo', 'Veículos', { parameters: [pathParam('id', 'ID')] }),
        delete: op('Arquiva veículo (exclusão lógica)', 'Veículos', { parameters: [pathParam('id', 'ID')] }),
      },
      '/vehicles/{id}/traffic-fines': {
        get: op('Consulta multas no provedor configurado', 'Veículos', {
          parameters: [pathParam('id', 'ID')],
          responses: {
            '200': { description: 'Resultado ou indisponibilidade explícita' },
            '503': { description: 'Provedor indisponível', ...json(ref('ApiError')) },
            ...errorResponses,
          },
        }),
      },
      '/vehicles/import/template': { get: op('Baixa a planilha modelo (XLSX)', 'Veículos') },
      '/vehicles/import/preview': { post: op('Pré-visualiza a importação com erros por linha', 'Veículos') },
      '/vehicles/import/commit': { post: op('Confirma a importação das linhas válidas', 'Veículos') },

      '/drivers': {
        get: op('Lista motoristas', 'Motoristas'),
        post: op('Cadastra motorista', 'Motoristas'),
      },
      '/drivers/{id}': {
        get: op('Detalhe do motorista', 'Motoristas', { parameters: [pathParam('id', 'ID')] }),
        patch: op('Atualiza motorista', 'Motoristas', { parameters: [pathParam('id', 'ID')] }),
        delete: op('Arquiva motorista', 'Motoristas', { parameters: [pathParam('id', 'ID')] }),
      },
      '/postal-codes/{cep}': {
        get: op('Consulta CEP no provedor configurado', 'Motoristas', {
          parameters: [pathParam('cep', 'CEP com 8 dígitos')],
        }),
      },

      '/rentals': { get: op('Lista locações', 'Locações'), post: op('Cadastra locação', 'Locações') },
      '/rentals/{id}': {
        get: op('Detalhe da locação', 'Locações', { parameters: [pathParam('id', 'ID')] }),
        patch: op('Atualiza locação', 'Locações', { parameters: [pathParam('id', 'ID')] }),
        delete: op('Cancela locação sem recebimentos', 'Locações', { parameters: [pathParam('id', 'ID')] }),
      },
      '/rentals/{id}/close': {
        post: op('Encerra a locação e libera o veículo', 'Locações', { parameters: [pathParam('id', 'ID')] }),
      },

      '/maintenance/vehicles': { get: op('Cartões de manutenção por veículo', 'Manutenções') },
      '/vehicles/{vehicleId}/maintenance': {
        get: op('Histórico de OS do veículo', 'Manutenções', { parameters: [pathParam('vehicleId', 'ID')] }),
        post: op('Registra nova OS (assistente de 3 etapas)', 'Manutenções', {
          parameters: [pathParam('vehicleId', 'ID')],
        }),
      },
      '/vehicles/{vehicleId}/maintenance/report.pdf': {
        get: op('Relatório de manutenções em PDF (A4 retrato)', 'Manutenções', {
          parameters: [pathParam('vehicleId', 'ID')],
        }),
      },
      '/maintenance/{id}': {
        get: op('Detalhe da OS', 'Manutenções', { parameters: [pathParam('id', 'ID')] }),
        patch: op('Atualiza a OS', 'Manutenções', { parameters: [pathParam('id', 'ID')] }),
        delete: op('Exclui a OS estornando o lançamento', 'Manutenções', { parameters: [pathParam('id', 'ID')] }),
      },
      '/maintenance/{id}/complete': {
        post: op('Conclui a OS e lança a saída bancária (uma única vez)', 'Manutenções', {
          parameters: [pathParam('id', 'ID')],
        }),
      },
      '/maintenance/{id}/cancel': {
        post: op('Cancela a OS e estorna o lançamento', 'Manutenções', { parameters: [pathParam('id', 'ID')] }),
      },
      '/traffic-fines': {
        get: op('Lista multas (filtros: status, veículo, motorista, locação, prazo, busca) com resumo', 'Multas'),
        post: op('Cadastra multa e identifica o motorista pela locação da data', 'Multas'),
      },
      '/traffic-fines/export.csv': { get: op('Exporta as multas filtradas em CSV', 'Multas') },
      '/traffic-fines/{id}': {
        get: op('Detalhe da multa com histórico e cobrança', 'Multas', { parameters: [pathParam('id', 'ID')] }),
        patch: op('Edita a multa (controle por version)', 'Multas', { parameters: [pathParam('id', 'ID')] }),
      },
      '/traffic-fines/{id}/rematch': {
        post: op('Refaz a identificação automática do motorista', 'Multas', { parameters: [pathParam('id', 'ID')] }),
      },
      '/traffic-fines/{id}/identify': {
        post: op('Define o motorista (e a locação) manualmente', 'Multas', { parameters: [pathParam('id', 'ID')] }),
      },
      '/traffic-fines/{id}/indicate': {
        post: op('Registra a indicação do condutor ao órgão', 'Multas', { parameters: [pathParam('id', 'ID')] }),
      },
      '/traffic-fines/{id}/charge': {
        post: op('Cobra a multa do motorista (conta a receber FINE, idempotente)', 'Multas', {
          parameters: [pathParam('id', 'ID')],
        }),
      },
      '/traffic-fines/{id}/contest': {
        post: op('Registra recurso (defesa prévia, JARI, CETRAN)', 'Multas', { parameters: [pathParam('id', 'ID')] }),
      },
      '/traffic-fines/{id}/appeal-result': {
        post: op('Resultado do recurso: deferido cancela, indeferido retoma', 'Multas', { parameters: [pathParam('id', 'ID')] }),
      },
      '/traffic-fines/{id}/company-liable': {
        post: op('A empresa assume a multa', 'Multas', { parameters: [pathParam('id', 'ID')] }),
      },
      '/traffic-fines/{id}/cancel': {
        post: op('Cancela a multa e estorna a cobrança', 'Multas', { parameters: [pathParam('id', 'ID')] }),
      },
      '/traffic-fines/{id}/notify-driver': {
        post: op('Avisa o motorista pelo WhatsApp (ou devolve link manual)', 'Multas', { parameters: [pathParam('id', 'ID')] }),
      },
      '/vehicles/{id}/traffic-fines/import': {
        post: op('Importa multas do provedor configurado (sem duplicar AIT)', 'Multas', { parameters: [pathParam('id', 'ID')] }),
      },

      '/inspection/photo-slots': {
        get: op('Tipos de foto configurados (máx. 12 ativos)', 'Vistorias'),
        put: op('Substitui a configuração de tipos de foto', 'Vistorias'),
        post: op('Adiciona um tipo de foto', 'Vistorias'),
      },
      '/inspections/vehicles': { get: op('Cartões de vistoria por veículo', 'Vistorias') },
      '/vehicles/{vehicleId}/inspections': {
        get: op('Histórico de vistorias do veículo', 'Vistorias', {
          parameters: [pathParam('vehicleId', 'ID')],
        }),
      },
      '/vehicles/{vehicleId}/inspections/request': {
        post: op('Solicita vistoria e envia o link ao responsável', 'Vistorias', {
          parameters: [pathParam('vehicleId', 'ID')],
        }),
      },
      '/inspections/{id}/review': {
        post: op('Aprova ou reprova a vistoria enviada', 'Vistorias', { parameters: [pathParam('id', 'ID')] }),
      },
      '/inspections/{id}': {
        delete: op('Cancela a vistoria', 'Vistorias', { parameters: [pathParam('id', 'ID')] }),
      },
      '/inspection-public/{token}': {
        get: op('Dados do formulário público de vistoria', 'Vistorias', {
          security: [],
          parameters: [pathParam('token', 'Token de uso único')],
        }),
      },
      '/inspection-public/{token}/photos': {
        post: op('Envia uma foto da vistoria', 'Vistorias', {
          security: [],
          parameters: [pathParam('token', 'Token')],
        }),
      },
      '/inspection-public/{token}/submit': {
        post: op('Conclui o envio da vistoria', 'Vistorias', {
          security: [],
          parameters: [pathParam('token', 'Token')],
        }),
      },

      '/bank-accounts': {
        get: op('Lista contas bancárias com saldo atual', 'Financeiro'),
        post: op('Cria conta bancária', 'Financeiro'),
      },
      '/bank-accounts/{id}': {
        patch: op('Atualiza conta bancária', 'Financeiro', { parameters: [pathParam('id', 'ID')] }),
        delete: op('Arquiva (ou exclui, se sem movimentos)', 'Financeiro', { parameters: [pathParam('id', 'ID')] }),
      },
      '/bank-accounts/{id}/manual-transactions': {
        post: op('Lançamento manual de entrada/saída', 'Financeiro', {
          parameters: [pathParam('id', 'ID')],
        }),
      },
      '/bank-accounts/{id}/statement': {
        get: op('Extrato com saldo acumulado', 'Financeiro', { parameters: [pathParam('id', 'ID')] }),
      },
      '/bank-accounts/{id}/statement.csv': {
        get: op('Exporta o extrato em CSV', 'Financeiro', { parameters: [pathParam('id', 'ID')] }),
      },
      '/expense-categories': {
        get: op('Categorias de despesa', 'Financeiro'),
        post: op('Cria categoria', 'Financeiro'),
      },
      '/payables': { get: op('Lista contas a pagar', 'Financeiro'), post: op('Cria conta a pagar', 'Financeiro') },
      '/payables/{id}': {
        get: op('Detalhe', 'Financeiro', { parameters: [pathParam('id', 'ID')] }),
        patch: op('Atualiza', 'Financeiro', { parameters: [pathParam('id', 'ID')] }),
        delete: op('Exclui ou estorna conta já paga', 'Financeiro', { parameters: [pathParam('id', 'ID')] }),
      },
      '/payables/{id}/payments': {
        post: op('Registra pagamento (aceita Idempotency-Key)', 'Financeiro', {
          parameters: [pathParam('id', 'ID')],
        }),
      },
      '/receivables': { get: op('Lista contas a receber e total pendente', 'Financeiro') },
      '/receivables/{id}': { get: op('Detalhe com histórico de pagamentos', 'Financeiro', { parameters: [pathParam('id', 'ID')] }) },
      '/receivables/{id}/payments': {
        post: op('Registra recebimento (aceita Idempotency-Key)', 'Financeiro', {
          parameters: [pathParam('id', 'ID')],
        }),
      },
      '/finance/refresh-statuses': { post: op('Recalcula status vencidos', 'Financeiro') },
      '/finance/dashboard': { get: op('Dashboard financeiro do período', 'Relatórios') },

      '/dashboard/summary': { get: op('Painel inicial', 'Relatórios') },
      '/reports/by-vehicle': { get: op('Relatório financeiro por veículo', 'Relatórios') },
      '/reports/by-client': { get: op('Relatório financeiro por cliente', 'Relatórios') },
      '/reports/dre': { get: op('DRE gerencial mensal', 'Relatórios') },
      '/reports/dre.pdf': { get: op('DRE em PDF', 'Relatórios') },

      '/notifications': { get: op('Lista notificações', 'Notificações') },
      '/notifications/unread-count': { get: op('Contagem de não lidas', 'Notificações') },
      '/notifications/{id}/read': { patch: op('Marca como lida', 'Notificações', { parameters: [pathParam('id', 'ID')] }) },
      '/notifications/mark-all-read': { post: op('Marca todas como lidas', 'Notificações') },
      '/notifications/refresh': { post: op('Reprocessa os geradores de alerta', 'Notificações') },
      '/message-templates': {
        get: op('Lista templates', 'Notificações'),
        post: op('Cria template', 'Notificações'),
      },
      '/message-templates/{id}': {
        patch: op('Atualiza template', 'Notificações', { parameters: [pathParam('id', 'ID')] }),
        delete: op('Exclui template', 'Notificações', { parameters: [pathParam('id', 'ID')] }),
      },
      '/message-dispatches': {
        get: op('Histórico de disparos', 'Notificações'),
        post: op('Dispara mensagens pelo provedor configurado', 'Notificações'),
      },
      '/message-dispatches/{id}': { get: op('Detalhe do disparo', 'Notificações', { parameters: [pathParam('id', 'ID')] }) },
      '/message-dispatches/{id}/retry': {
        post: op('Reenvia falhas do disparo', 'Notificações', { parameters: [pathParam('id', 'ID')] }),
      },
      '/integrations/status': { get: op('Estado real das integrações externas', 'Notificações') },

      '/employees': { get: op('Colaboradores, convites e cotas', 'Organização') },
      '/invitations': { post: op('Cria convite com permissões por módulo', 'Organização') },
      '/invitations/{id}': { delete: op('Revoga convite', 'Organização', { parameters: [pathParam('id', 'ID')] }) },
      '/memberships/{id}/permissions': {
        patch: op('Atualiza permissões do colaborador', 'Organização', { parameters: [pathParam('id', 'ID')] }),
      },
      '/memberships/{id}': {
        delete: op('Remove colaborador e revoga sessões', 'Organização', { parameters: [pathParam('id', 'ID')] }),
      },
      '/subscription': { get: op('Assinatura, extrato do período e faturas', 'Organização') },
      '/subscription/invoices/{id}/link': {
        get: op('Link oficial de pagamento (exige provedor conectado)', 'Organização', {
          parameters: [pathParam('id', 'ID')],
        }),
      },
      '/subscription/refresh': { post: op('Solicita sincronização ao provedor', 'Organização') },
    },
  };
}
