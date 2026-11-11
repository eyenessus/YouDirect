import { z } from 'zod';
import { emailSchema, nonEmptyString, objectIdSchema, optionalPhoneSchema } from './common.js';
import { membershipRoleSchema } from './enums.js';
import { permissionMatrixSchema } from './permissions.js';

/* ----------------------------- senhas ------------------------------ */

export const MIN_PASSWORD_LENGTH = 8;

/** Senhas mais usadas em vazamentos públicos (comparação sem caixa). */
const COMMON_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password1', 'senha123', 'senha1234', 'qwerty123',
  '11111111', '00000000', '12341234', 'abcd1234', 'iloveyou', 'admin123', 'brasil123', 'mudar123',
  'abc12345', 'qwertyui', '87654321', 'yudirect', 'frotaone',
]);

/** Motivo da recusa, ou null quando a senha é aceitável. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Mínimo de ${MIN_PASSWORD_LENGTH} caracteres`;
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'Senha muito comum — escolha outra';
  if (/^(.)\1+$/.test(password)) return 'Não use um único caractere repetido';
  return null;
}

/** Para senhas NOVAS (cadastro, troca, redefinição). Senhas antigas seguem válidas no login. */
export const newPasswordSchema = z
  .string()
  .max(200)
  .superRefine((value, ctx) => {
    const problem = passwordProblem(value);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Informe a senha').max(200),
  organizationId: objectIdSchema.optional(),
  /** Token do Cloudflare Turnstile (obrigatório quando o anti-robô está ligado). */
  captchaToken: z.string().max(2048).optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1, 'Informe a senha atual').max(200),
    newPassword: newPasswordSchema,
    confirmPassword: z.string().min(1, 'Confirme a senha').max(200),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'As senhas não coincidem',
    path: ['confirmPassword'],
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    message: 'A nova senha deve ser diferente da atual',
    path: ['newPassword'],
  });
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const sessionOrganizationSchema = z.object({
  id: objectIdSchema,
  name: z.string(),
  legalId: z.string().nullable(),
  role: membershipRoleSchema,
  permissions: permissionMatrixSchema,
});
export type SessionOrganization = z.infer<typeof sessionOrganizationSchema>;

export const sessionUserSchema = z.object({
  id: objectIdSchema,
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  initials: z.string(),
  browserNotificationsEnabled: z.boolean(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const meResponseSchema = z.object({
  user: sessionUserSchema,
  organization: sessionOrganizationSchema,
  organizations: z.array(
    z.object({ id: objectIdSchema, name: z.string(), role: membershipRoleSchema }),
  ),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const updateProfileRequestSchema = z.object({
  name: nonEmptyString(120),
  phone: optionalPhoneSchema,
});
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

export const notificationPreferencesRequestSchema = z.object({
  browserNotificationsEnabled: z.boolean(),
});
export type NotificationPreferencesRequest = z.infer<typeof notificationPreferencesRequestSchema>;

export const acceptInvitationRequestSchema = z
  .object({
    token: z.string().min(16).max(200),
    name: nonEmptyString(120),
    // Conta nova: a força é validada na rota (passwordProblem). Conta que já
    // existe: é a senha ATUAL dela, que comprova a posse do e-mail.
    password: z.string().min(1, 'Informe a senha').max(200),
    confirmPassword: z.string().min(1).max(200),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'As senhas não coincidem',
    path: ['confirmPassword'],
  });
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;

export const requestPasswordResetSchema = z.object({ email: emailSchema });
export const confirmPasswordResetSchema = z
  .object({
    token: z.string().min(16).max(200),
    password: newPasswordSchema,
    confirmPassword: z.string().min(1).max(200),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'As senhas não coincidem',
    path: ['confirmPassword'],
  });
