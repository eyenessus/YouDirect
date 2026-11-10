import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Configuração por ambiente. Nenhum segredo é embutido no código.
 * Integrações externas só são consideradas "conectadas" quando as
 * credenciais correspondentes estiverem realmente presentes.
 * ------------------------------------------------------------------ */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

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
  SESSION_SECRET: z.string().min(16).default('dev-only-session-secret-change-me'),
  COOKIE_SECURE: booleanish.default(false),

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

  POSTAL_CODE_PROVIDER_URL: z.string().optional(),

  TRAFFIC_FINES_PROVIDER: z.string().optional(),
  TRAFFIC_FINES_API_URL: z.string().optional(),
  TRAFFIC_FINES_API_TOKEN: z.string().optional(),

  BILLING_PROVIDER: z.string().optional(),
  BILLING_API_URL: z.string().optional(),
  BILLING_API_TOKEN: z.string().optional(),

  JOBS_ENABLED: booleanish.default(true),
  JOBS_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),

  RATE_LIMIT_MAX: z.coerce.number().int().min(10).max(100000).default(600),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(3).max(100).default(10),

  SEED_OWNER_EMAIL: z.string().default('erik@ffveiculos.example.com'),
  SEED_OWNER_PASSWORD: z.string().default('YuDirect@2026'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Configuração de ambiente inválida:\n  ${details}`);
  }
  cached = parsed.data;
  return cached;
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

export function emailStatus(env: Env): IntegrationStatus {
  const connected = Boolean(env.EMAIL_API_URL && env.EMAIL_API_TOKEN && env.EMAIL_FROM);
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
