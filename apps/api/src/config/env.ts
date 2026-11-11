import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Configuração por ambiente. Nenhum segredo é embutido no código.
 * Integrações externas só são consideradas "conectadas" quando as
 * credenciais correspondentes estiverem realmente presentes.
 * ------------------------------------------------------------------ */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

export const DEV_SESSION_SECRET = 'dev-only-session-secret-change-me';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3333),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Vazio em desenvolvimento => sobe um MongoDB em memória (replica set). */
  MONGODB_URI: z.string().optional(),
  MONGODB_DB: z.string().default('yudirect'),
  /** Diretório de dados do MongoDB em memória (dev/test). */
  MONGO_MEMORY_DB_PATH: z.string().default('./.cache/mongo-data'),

  APP_URL: z.string().url().default('http://localhost:5173'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:3333'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  SESSION_COOKIE_NAME: z.string().default('yudirect_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  SESSION_SECRET: z.string().min(16).default(DEV_SESSION_SECRET),
  COOKIE_SECURE: booleanish.default(false),

  /*
   * Criptografia de PII (CPF/RG) — independente do SESSION_SECRET.
   * Sem PII_KEY, o formato legado (derivado de PII_LEGACY_SECRET ou do
   * SESSION_SECRET) continua em uso. Ver scripts/rotate-pii.ts.
   */
  PII_KEY: z.string().min(32).optional(),
  PII_KEY_ID: z.string().regex(/^[a-z0-9_-]{1,16}$/i).default('k1'),
  PII_KEY_PREVIOUS: z.string().min(32).optional(),
  PII_KEY_PREVIOUS_ID: z.string().regex(/^[a-z0-9_-]{1,16}$/i).optional(),
  /** Segredo que cifrou os dados v1 (o SESSION_SECRET antigo, após rotacioná-lo). */
  PII_LEGACY_SECRET: z.string().min(16).optional(),
  /** Pepper do hash de busca de CPF. Padrão: segredo legado (compatível com os dados atuais). */
  PII_PEPPER: z.string().min(16).optional(),

  STORAGE_DRIVER: z.enum(['mongo', 'local', 's3']).default('mongo'),
  STORAGE_LOCAL_DIR: z.string().default('./.storage'),
  STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(86400).default(900),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  /* Integrações externas — ausentes => modo "indisponível" honesto. */
  WHATSAPP_PROVIDER: z.string().optional(),
  WHATSAPP_API_URL: z.string().optional(),
  WHATSAPP_API_TOKEN: z.string().optional(),
  WHATSAPP_SENDER_ID: z.string().optional(),

  /* Whaply (canal oficial WhatsApp da FF Veículos) — plano §5.1. */
  WHAPLY_INTEGRATION_ENABLED: booleanish.default(false),
  WHAPLY_API_URL: z.string().url().optional(),
  /** Chave YuDirect → Whaply (assinamos os comandos). */
  WHAPLY_OUTBOUND_KEY_ID: z.string().optional(),
  WHAPLY_OUTBOUND_SECRET: z.string().min(32).optional(),
  /** Chaves Whaply → YuDirect (verificamos os eventos); NEXT = rotação. */
  WHAPLY_INBOUND_KEY_ID: z.string().optional(),
  WHAPLY_INBOUND_SECRET: z.string().min(32).optional(),
  WHAPLY_INBOUND_KEY_ID_NEXT: z.string().optional(),
  WHAPLY_INBOUND_SECRET_NEXT: z.string().min(32).optional(),
  WHAPLY_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  WHAPLY_TEMPLATE_REQUEST: z.string().default('yudirect_vistoria_solicitacao'),
  WHAPLY_TEMPLATE_REMINDER: z.string().default('yudirect_vistoria_lembrete'),
  WHAPLY_TEMPLATE_CORRECTION: z.string().default('yudirect_vistoria_correcao'),
  WHAPLY_TEMPLATE_LANGUAGE: z.string().default('pt_BR'),
  /** Intervalo dos jobs da integração (disparo, outbox, reconciliação). */
  WHAPLY_JOBS_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),

  EMAIL_PROVIDER: z.string().optional(),
  EMAIL_API_URL: z.string().optional(),
  EMAIL_API_TOKEN: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  // EMAIL_PROVIDER=mailgun usa estas (e EMAIL_FROM).
  MAILGUN_API_KEY: z.string().optional(),
  MAILGUN_DOMAIN: z.string().optional(),
  MAILGUN_REGION: z.enum(['us', 'eu']).default('us'),
  /** Só para testes/proxy: substitui https://api.mailgun.net. */
  MAILGUN_API_URL: z.string().url().optional(),

  POSTAL_CODE_PROVIDER_URL: z.string().optional(),

  TRAFFIC_FINES_PROVIDER: z.string().optional(),
  TRAFFIC_FINES_API_URL: z.string().optional(),
  TRAFFIC_FINES_API_TOKEN: z.string().optional(),

  BILLING_PROVIDER: z.string().optional(),
  BILLING_API_URL: z.string().optional(),
  BILLING_API_TOKEN: z.string().optional(),

  /* Pix (Mercado Pago, API de pagamentos). Sem token => cobrança Pix indisponível. */
  MERCADOPAGO_ACCESS_TOKEN: z.string().optional(),
  /** Assinatura secreta dos webhooks (painel do Mercado Pago > Webhooks). Obrigatória para receber baixas. */
  MERCADOPAGO_WEBHOOK_SECRET: z.string().optional(),
  MERCADOPAGO_API_URL: z.string().url().default('https://api.mercadopago.com'),
  /** E-mail do pagador quando o motorista não tem e-mail (exigido pela API). */
  PIX_PAYER_FALLBACK_EMAIL: z.string().email().optional(),
  PIX_EXPIRATION_MINUTES: z.coerce.number().int().min(30).max(43_200).default(1440),

  /* Assinatura digital (ZapSign). Sem token => assinatura indisponível (PDF continua disponível). */
  ZAPSIGN_API_TOKEN: z.string().optional(),
  ZAPSIGN_API_URL: z.string().url().default('https://api.zapsign.com.br'),
  /** Valor do cabeçalho Authorization ("Bearer <segredo>") configurado no webhook da ZapSign. */
  ZAPSIGN_WEBHOOK_SECRET: z.string().optional(),
  /** Validação da selfie: face-match-and-datavalid (selfie × base do governo pelo CPF), liveness-NXCD ou none. */
  ZAPSIGN_SELFIE_VALIDATION: z.enum(['face-match-and-datavalid', 'liveness-NXCD', 'none']).default('face-match-and-datavalid'),

  /* Serasa Experian — Relatório Básico PF (análise de crédito do motorista).
   * Sem credenciais => consulta indisponível (nada é simulado). */
  SERASA_ENVIRONMENT: z.enum(['homologacao', 'producao']).default('homologacao'),
  SERASA_CLIENT_ID: z.string().optional(),
  SERASA_CLIENT_SECRET: z.string().optional(),
  /** Só para testes/proxy homologado: substitui a URL base oficial do ambiente. */
  SERASA_API_URL: z.string().url().optional(),
  SERASA_REPORT_NAME: z.string().regex(/^[A-Z0-9_]+$/).default('RELATORIO_BASICO_PF_PME'),
  /** Features opcionais contratadas, separadas por vírgula (ex.: ANOTACOES_COMPLETAS_PME). */
  SERASA_OPTIONAL_FEATURES: z.string().regex(/^[A-Z0-9_,]*$/).default(''),
  /** Modelo de score enviado em reportParameters (ex.: HRLN). Vazio = padrão do relatório. */
  SERASA_SCORE_MODEL: z.string().regex(/^[A-Z0-9]*$/).optional(),
  /** Cliente distribuidor: CNPJ do consultante (X-Retailer-Document-Id). */
  SERASA_RETAILER_DOCUMENT: z.string().regex(/^\d{14}$/).optional(),
  SERASA_COST_CENTER: z.string().max(12).optional(),
  SERASA_TIMEOUT_MS: z.coerce.number().int().min(2000).max(60_000).default(20_000),
  /** Consultas por minuto por cliente na rota de consulta (proteção contra uso em massa). */
  SERASA_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(20),

  JOBS_ENABLED: booleanish.default(true),
  JOBS_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),

  RATE_LIMIT_MAX: z.coerce.number().int().min(10).max(100000).default(600),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(3).max(100).default(10),

  /* Cloudflare Turnstile na tela de login (anti-robô). Sem as duas chaves => desligado. */
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  TURNSTILE_VERIFY_URL: z.string().url().default('https://challenges.cloudflare.com/turnstile/v0/siteverify'),

  SEED_OWNER_EMAIL: z.string().default('erik@ffveiculos.example.com'),
  SEED_OWNER_PASSWORD: z.string().default('YuDirect@2026'),
});

export type Env = z.infer<typeof envSchema>;

const LOCALHOST = /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i;

/**
 * Em produção, recusa subir com padrões de desenvolvimento: um segredo de
 * sessão conhecido permite forjar links de arquivo e expõe a chave de PII;
 * URLs em localhost quebram convites, vistorias e a proteção CSRF.
 */
export function productionProblems(env: Env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];
  if (env.SESSION_SECRET === DEV_SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    problems.push('SESSION_SECRET: defina um segredo aleatório com 32+ caracteres (ex.: openssl rand -hex 32).');
  }
  if (!env.COOKIE_SECURE) problems.push('COOKIE_SECURE: deve ser true em produção (HTTPS).');
  if (!env.MONGODB_URI) problems.push('MONGODB_URI: obrigatório em produção.');
  if (LOCALHOST.test(env.APP_URL)) problems.push('APP_URL: aponta para localhost.');
  if (LOCALHOST.test(env.API_PUBLIC_URL)) problems.push('API_PUBLIC_URL: aponta para localhost.');
  if (corsOrigins(env).length === 0 || corsOrigins(env).every((o) => LOCALHOST.test(o))) {
    problems.push('CORS_ORIGINS: inclua o domínio público (a proteção CSRF recusaria todo POST).');
  }
  if (Boolean(env.TURNSTILE_SITE_KEY) !== Boolean(env.TURNSTILE_SECRET_KEY)) {
    problems.push('TURNSTILE_SITE_KEY e TURNSTILE_SECRET_KEY: configure as duas chaves juntas (ou nenhuma).');
  }
  if (env.TURNSTILE_SECRET_KEY?.startsWith('1x0000') || env.TURNSTILE_SECRET_KEY?.startsWith('2x0000') || env.TURNSTILE_SECRET_KEY?.startsWith('3x0000')) {
    problems.push('TURNSTILE_SECRET_KEY: chave de TESTE da Cloudflare não pode ser usada em produção.');
  }
  if (env.PII_KEY && env.PII_KEY === env.SESSION_SECRET) {
    problems.push('PII_KEY: não reutilize o SESSION_SECRET.');
  }
  return problems;
}

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Configuração de ambiente inválida:\n  ${details}`);
  }
  const problems = productionProblems(parsed.data);
  if (problems.length > 0) {
    throw new Error(`Configuração insegura para produção:\n  ${problems.join('\n  ')}`);
  }
  cached = parsed.data;
  return cached;
}

/** Segredo do formato legado de PII e pepper do hash de CPF (compatíveis com os dados atuais). */
export function piiLegacySecret(env: Env): string {
  return env.PII_LEGACY_SECRET ?? env.SESSION_SECRET;
}

export function piiPepper(env: Env): string {
  return env.PII_PEPPER ?? piiLegacySecret(env);
}

export function resetEnvCache(): void {
  cached = null;
}

export function corsOrigins(env: Env): string[] {
  return env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
}

export interface IntegrationStatus {
  name: string | null;
  connected: boolean;
  message: string;
}

export function pixStatus(env: Env): IntegrationStatus {
  const connected = Boolean(env.MERCADOPAGO_ACCESS_TOKEN);
  return {
    name: connected ? 'mercadopago' : null,
    connected,
    message: connected
      ? 'Cobrança Pix pelo Mercado Pago configurada.'
      : 'Cobrança Pix não configurada (MERCADOPAGO_ACCESS_TOKEN). Nenhuma cobrança é gerada automaticamente.',
  };
}

export function signatureStatus(env: Env): IntegrationStatus {
  const connected = Boolean(env.ZAPSIGN_API_TOKEN);
  return {
    name: connected ? 'zapsign' : null,
    connected,
    message: connected
      ? 'Assinatura digital pela ZapSign configurada.'
      : 'Assinatura digital não configurada (ZAPSIGN_API_TOKEN). O contrato pode ser baixado em PDF e anexado assinado.',
  };
}

/** URL base oficial de cada ambiente da Serasa (manual do Relatório Básico PF, §2.2). */
export const SERASA_BASE_URLS = {
  homologacao: 'https://uat-api.serasaexperian.com.br',
  producao: 'https://api.serasaexperian.com.br',
} as const;

export function serasaBaseUrl(env: Env): string {
  return (env.SERASA_API_URL ?? SERASA_BASE_URLS[env.SERASA_ENVIRONMENT]).replace(/\/$/, '');
}

export function creditStatus(env: Env): IntegrationStatus {
  const hasCredentials = Boolean(env.SERASA_CLIENT_ID && env.SERASA_CLIENT_SECRET);
  if (!hasCredentials) {
    return {
      name: null,
      connected: false,
      message: 'Serasa não configurada (SERASA_CLIENT_ID e SERASA_CLIENT_SECRET). Nenhuma consulta de crédito é feita.',
    };
  }
  // Separação de ambientes: credencial de produção só roda no servidor de produção.
  if (env.SERASA_ENVIRONMENT === 'producao' && env.NODE_ENV !== 'production') {
    return {
      name: null,
      connected: false,
      message: 'Credenciais de PRODUÇÃO da Serasa bloqueadas fora do servidor de produção. Use SERASA_ENVIRONMENT=homologacao.',
    };
  }
  if (env.SERASA_API_URL && env.NODE_ENV === 'production') {
    const host = new URL(env.SERASA_API_URL).hostname;
    if (env.SERASA_API_URL.startsWith('http:') || !/(^|\.)serasaexperian\.com\.br$/.test(host)) {
      return { name: null, connected: false, message: 'SERASA_API_URL precisa ser HTTPS em *.serasaexperian.com.br em produção.' };
    }
  }
  return {
    name: 'serasa',
    connected: true,
    message: `Serasa Experian configurada (${env.SERASA_ENVIRONMENT === 'producao' ? 'produção' : 'homologação'}).`,
  };
}

export function whatsappStatus(env: Env): IntegrationStatus {
  const connected = Boolean(env.WHATSAPP_API_URL && env.WHATSAPP_API_TOKEN);
  return {
    name: env.WHATSAPP_PROVIDER ?? (connected ? 'whatsapp' : null),
    connected,
    message: connected
      ? 'Provedor de WhatsApp configurado.'
      : 'Provedor de WhatsApp não configurado — nenhuma mensagem é enviada automaticamente. Use o link manual (wa.me) por destinatário.',
  };
}

export function whaplyStatus(env: Env): IntegrationStatus {
  const configured = Boolean(
    env.WHAPLY_API_URL &&
      env.WHAPLY_OUTBOUND_KEY_ID &&
      env.WHAPLY_OUTBOUND_SECRET &&
      env.WHAPLY_INBOUND_KEY_ID &&
      env.WHAPLY_INBOUND_SECRET,
  );
  const connected = configured && env.WHAPLY_INTEGRATION_ENABLED;
  return {
    name: connected ? 'whaply' : null,
    connected,
    message: connected
      ? 'Coleta de vistoria pelo WhatsApp (Whaply) habilitada.'
      : configured
        ? 'Integração com o Whaply configurada, porém desligada (WHAPLY_INTEGRATION_ENABLED=false).'
        : 'Integração com o Whaply não configurada — a vistoria usa o link web ou o envio manual.',
  };
}

export function isMailgun(env: Env): boolean {
  return (env.EMAIL_PROVIDER ?? '').toLowerCase() === 'mailgun';
}

export function emailStatus(env: Env): IntegrationStatus {
  const connected = isMailgun(env)
    ? Boolean(env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN && env.EMAIL_FROM)
    : Boolean(env.EMAIL_API_URL && env.EMAIL_API_TOKEN && env.EMAIL_FROM);
  return {
    name: env.EMAIL_PROVIDER ?? (connected ? 'email' : null),
    connected,
    message: connected
      ? 'Provedor de e-mail configurado.'
      : 'Provedor de e-mail não configurado — o link precisa ser entregue manualmente.',
  };
}

export function postalCodeStatus(env: Env): IntegrationStatus {
  const connected = Boolean(env.POSTAL_CODE_PROVIDER_URL);
  return {
    name: connected ? 'cep' : null,
    connected,
    message: connected
      ? 'Serviço de CEP configurado.'
      : 'Consulta de CEP não configurada — preencha o endereço manualmente.',
  };
}

export function trafficFinesStatus(env: Env): IntegrationStatus {
  const connected = Boolean(env.TRAFFIC_FINES_API_URL && env.TRAFFIC_FINES_API_TOKEN);
  return {
    name: env.TRAFFIC_FINES_PROVIDER ?? (connected ? 'multas' : null),
    connected,
    message: connected
      ? 'Serviço de consulta de multas configurado.'
      : 'Consulta de multas não configurada — nenhum dado de DETRAN é exibido ou simulado.',
  };
}

export function billingStatus(env: Env): IntegrationStatus {
  const connected = Boolean(env.BILLING_API_URL && env.BILLING_API_TOKEN);
  return {
    name: env.BILLING_PROVIDER ?? (connected ? 'billing' : null),
    connected,
    message: connected
      ? 'Provedor de cobrança configurado.'
      : 'Provedor de cobrança não conectado — links de pagamento só aparecem quando vierem do provedor real.',
  };
}

/**
 * Carrega o `.env` da raiz do monorepo (ou da pasta atual) no
 * `process.env`, sem sobrescrever variáveis já definidas no ambiente.
 * Usado apenas pelos pontos de entrada (servidor e seed) — os testes
 * passam o ambiente explicitamente e não são afetados.
 */
export function loadDotEnv(): void {
  for (const path of ['.env', '../../.env']) {
    try {
      process.loadEnvFile(path);
    } catch {
      /* arquivo ausente: segue com o ambiente atual */
    }
  }
}
