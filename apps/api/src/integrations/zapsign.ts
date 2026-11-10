import { signatureStatus, type Env, type IntegrationStatus } from '../config/env.js';

/* ------------------------------------------------------------------ *
 * Assinatura digital pela ZapSign (docs.zapsign.com.br).
 * - POST /api/v1/docs/ com base64_pdf e o motorista como signatário,
 *   exigindo selfie e foto do documento (CNH). Com CPF, a selfie é
 *   comparada à base do governo ("face-match-and-datavalid").
 * - GET /api/v1/docs/{token}/ confirma o estado: o webhook só dispara a
 *   consulta, nunca é a fonte da verdade (a ZapSign não assina o webhook).
 * ------------------------------------------------------------------ */

export interface SignatureCreateInput {
  name: string;
  base64Pdf: string;
  externalId: string;
  signer: { name: string; email: string | null; phone: string; cpf: string | null };
  selfieValidation: 'face-match-and-datavalid' | 'liveness-NXCD' | 'none';
}

export interface SignatureCreated {
  docToken: string;
  signerToken: string | null;
  signUrl: string | null;
  validationType: string | null;
}

export interface SignatureDocInfo {
  docToken: string;
  status: string;
  signedFileUrl: string | null;
  signedAt: Date | null;
  selfie: boolean;
  document: boolean;
}

export interface SignatureProvider {
  status(): IntegrationStatus;
  create(input: SignatureCreateInput): Promise<SignatureCreated>;
  get(docToken: string): Promise<SignatureDocInfo>;
  download(url: string): Promise<Buffer>;
}

const TIMEOUT_MS = 20_000;

export function createSignatureProvider(env: Env): SignatureProvider {
  const status = signatureStatus(env);
  const base = env.ZAPSIGN_API_URL.replace(/\/$/, '');
  const headers = () => ({
    authorization: `Bearer ${env.ZAPSIGN_API_TOKEN}`,
    'content-type': 'application/json',
    accept: 'application/json',
  });

  return {
    status: () => status,

    async create(input) {
      if (!status.connected) throw new Error(status.message);
      const validation =
        input.selfieValidation === 'face-match-and-datavalid' && !input.signer.cpf ? 'liveness-NXCD' : input.selfieValidation;
      const res = await fetch(`${base}/api/v1/docs/`, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: headers(),
        body: JSON.stringify({
          name: input.name.slice(0, 255),
          base64_pdf: input.base64Pdf,
          external_id: input.externalId,
          lang: 'pt-br',
          signers: [
            {
              name: input.signer.name,
              ...(input.signer.email ? { email: input.signer.email } : {}),
              phone_country: '55',
              phone_number: input.signer.phone,
              auth_mode: 'assinaturaTela',
              send_automatic_email: false,
              send_automatic_whatsapp: false,
              require_selfie_photo: true,
              require_document_photo: true,
              ...(input.signer.cpf ? { cpf: input.signer.cpf, require_cpf: true, validate_cpf: true } : {}),
              ...(validation !== 'none' ? { selfie_validation_type: validation } : {}),
              lock_name: true,
              lock_phone: true,
            },
          ],
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        token?: string;
        detail?: string;
        signers?: Array<{ token?: string; sign_url?: string }>;
      };
      if (!res.ok || !body.token) {
        throw new Error(`ZapSign recusou o documento (HTTP ${res.status}${body.detail ? `: ${body.detail}` : ''}).`);
      }
      const signer = body.signers?.[0];
      return {
        docToken: body.token,
        signerToken: signer?.token ?? null,
        signUrl: signer?.sign_url ?? null,
        validationType: validation === 'none' ? null : validation,
      };
    },

    async get(docToken) {
      if (!status.connected) throw new Error(status.message);
      const res = await fetch(`${base}/api/v1/docs/${encodeURIComponent(docToken)}/`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: headers(),
      });
      if (!res.ok) throw new Error(`ZapSign retornou HTTP ${res.status} ao consultar o documento.`);
      const body = (await res.json()) as {
        token: string;
        status: string;
        signed_file?: string | null;
        signers?: Array<{ status?: string; signed_at?: string | null; require_selfie_photo?: boolean; require_document_photo?: boolean }>;
      };
      const signer = body.signers?.[0];
      return {
        docToken: body.token,
        status: body.status,
        signedFileUrl: body.signed_file ?? null,
        signedAt: signer?.signed_at ? new Date(signer.signed_at) : null,
        selfie: Boolean(signer?.require_selfie_photo),
        document: Boolean(signer?.require_document_photo),
      };
    },

    async download(url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Falha ao baixar o PDF assinado (HTTP ${res.status}).`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
