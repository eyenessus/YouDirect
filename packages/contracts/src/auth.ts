import { z } from 'zod';
import { emailSchema, nonEmptyString, objectIdSchema, optionalPhoneSchema } from './common.js';
import { membershipRoleSchema } from './enums.js';
import { permissionMatrixSchema } from './permissions.js';

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Informe a senha').max(200),
  organizationId: objectIdSchema.optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1, 'Informe a senha atual').max(200),
    newPassword: z.string().min(6, 'Mínimo 6 caracteres').max(200),
    confirmPassword: z.string().min(6, 'Mínimo 6 caracteres').max(200),
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
    password: z.string().min(6, 'Mínimo 6 caracteres').max(200),
    confirmPassword: z.string().min(6).max(200),
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
    password: z.string().min(6, 'Mínimo 6 caracteres').max(200),
    confirmPassword: z.string().min(6).max(200),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'As senhas não coincidem',
    path: ['confirmPassword'],
  });
