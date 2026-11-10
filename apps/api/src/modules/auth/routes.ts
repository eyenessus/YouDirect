import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import {
  acceptInvitationRequestSchema,
  changePasswordRequestSchema,
  confirmPasswordResetSchema,
  loginRequestSchema,
  requestPasswordResetSchema,
  notificationPreferencesRequestSchema,
  passwordProblem,
  updateProfileRequestSchema,
  type MeResponse,
} from '@yudirect/contracts';
import { badRequest, conflict, forbidden, notFound, rateLimited, unauthorized } from '../../common/errors.js';
import type { AppContext } from '../../context.js';
import {
  generateToken,
  hashPassword,
  initialsOf,
  sha256,
  verifyPassword,
} from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { audit } from '../../services/common.js';

/* --------------------- bloqueio por conta (login) -------------------- *
 * Complementa o limite por IP: 10 senhas erradas para o MESMO e-mail em
 * 15 minutos bloqueiam esse e-mail por 15 minutos, venha de onde vier.
 * Vale também para e-mails inexistentes — o bloqueio não revela se a conta
 * existe.
 * ------------------------------------------------------------------ */
export const LOGIN_LOCK_THRESHOLD = 10;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const PASSWORD_RESET_MAX_PER_HOUR = 3;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

async function assertNotLocked(ctx: AppContext, email: string): Promise<void> {
  const attempt = await ctx.mongo.collections.loginAttempts.findOne({ _id: email });
  if (attempt?.lockedUntil && attempt.lockedUntil.getTime() > Date.now()) {
    throw rateLimited('Muitas tentativas para este e-mail. Aguarde alguns minutos e tente novamente.');
  }
}

async function registerFailure(ctx: AppContext, email: string): Promise<void> {
  const now = new Date();
  const c = ctx.mongo.collections.loginAttempts;
  const current = await c.findOne({ _id: email });
  const fresh = !current || now.getTime() - current.windowStart.getTime() > LOGIN_WINDOW_MS;
  const failures = fresh ? 1 : current!.failures + 1;
  const lockedUntil = failures >= LOGIN_LOCK_THRESHOLD ? new Date(now.getTime() + LOGIN_LOCK_MS) : null;
  await c.updateOne(
    { _id: email },
    {
      $set: {
        failures: lockedUntil ? 0 : failures,
        windowStart: fresh || lockedUntil ? now : current!.windowStart,
        lockedUntil,
        expiresAt: new Date(now.getTime() + LOGIN_WINDOW_MS + LOGIN_LOCK_MS),
      },
    },
    { upsert: true },
  );
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: { loginRateLimit?: number } = {},
): Promise<void> {
  /* ------------------------------- login --------------------------- */
  app.post(
    '/auth/login',
    {
      config: { rateLimit: { max: options.loginRateLimit ?? 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const ctx = request.appCtx;
      const body = loginRequestSchema.parse(request.body);
      await assertNotLocked(ctx, body.email);

      const user = await ctx.mongo.collections.users.findOne({ emailLower: body.email });
      // Mensagem genérica: não revela se o e-mail existe.
      const invalid = unauthorized('E-mail ou senha inválidos.');
      if (!user || user.status !== 'ACTIVE') {
        // custo constante aproximado
        await verifyPassword(body.password, 'scrypt$32768$8$2$AAAA$AAAA');
        await registerFailure(ctx, body.email);
        throw invalid;
      }
      const ok = await verifyPassword(body.password, user.passwordHash);
      if (!ok) {
        await registerFailure(ctx, body.email);
        throw invalid;
      }
      await ctx.mongo.collections.loginAttempts.deleteOne({ _id: body.email });

      const memberships = await ctx.mongo.collections.memberships
        .find({ userId: user._id, status: 'ACTIVE' })
        .toArray();
      if (memberships.length === 0) throw forbidden('Seu usuário não está vinculado a uma organização.');

      const membership = body.organizationId
        ? memberships.find((m) => m.organizationId.toHexString() === body.organizationId)
        : memberships[0];
      if (!membership) throw forbidden('Organização indisponível para este usuário.');

      const token = generateToken(32);
      const expiresAt = new Date(Date.now() + ctx.env.SESSION_TTL_HOURS * 3600 * 1000);
      await ctx.mongo.collections.sessions.insertOne({
        _id: new ObjectId(),
        userId: user._id,
        organizationId: membership.organizationId,
        tokenHash: sha256(token),
        createdAt: new Date(),
        expiresAt,
        revokedAt: null,
        userAgent: request.headers['user-agent']?.slice(0, 200) ?? null,
        ip: request.ip ?? null,
      });
      await ctx.mongo.collections.users.updateOne(
        { _id: user._id },
        { $set: { lastLoginAt: new Date(), updatedAt: new Date() } },
      );

      reply.setCookie(ctx.env.SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: ctx.env.COOKIE_SECURE,
        path: '/',
        expires: expiresAt,
      });

      return { ok: true };
    },
  );

  /* -------------------------------- me ----------------------------- */
  app.get('/auth/me', { onRequest: [app.requireAuth] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);

    const [user, organization, memberships] = await Promise.all([
      ctx.mongo.collections.users.findOne({ _id: auth.userId }),
      ctx.mongo.collections.organizations.findOne({ _id: auth.organizationId }),
      ctx.mongo.collections.memberships.find({ userId: auth.userId, status: 'ACTIVE' }).toArray(),
    ]);
    if (!user || !organization) throw unauthorized();

    const orgIds = memberships.map((m) => m.organizationId);
    const orgs = await ctx.mongo.collections.organizations.find({ _id: { $in: orgIds } }).toArray();
    const orgById = new Map(orgs.map((o) => [o._id.toHexString(), o]));

    const payload: MeResponse = {
      user: {
        id: user._id.toHexString(),
        name: user.name,
        email: user.emailLower,
        phone: user.phone,
        initials: initialsOf(user.name),
        browserNotificationsEnabled: user.browserNotificationsEnabled,
      },
      organization: {
        id: organization._id.toHexString(),
        name: organization.name,
        legalId: organization.legalId,
        role: auth.role,
        permissions: auth.permissions,
      },
      organizations: memberships.map((m) => ({
        id: m.organizationId.toHexString(),
        name: orgById.get(m.organizationId.toHexString())?.name ?? '—',
        role: m.role,
      })),
    };
    return payload;
  });

  /* ------------------------------ logout --------------------------- */
  app.post('/auth/logout', async (request, reply) => {
    const ctx = request.appCtx;
    if (request.auth) {
      await ctx.mongo.collections.sessions.updateOne(
        { _id: request.auth.sessionId },
        { $set: { revokedAt: new Date() } },
      );
    }
    reply.clearCookie(ctx.env.SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  /* ------------------------- troca de senha ------------------------ */
  app.post(
    '/auth/password/change',
    { onRequest: [app.requireAuth], config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = changePasswordRequestSchema.parse(request.body);

      const user = await ctx.mongo.collections.users.findOne({ _id: auth.userId });
      if (!user) throw unauthorized();
      const ok = await verifyPassword(body.currentPassword, user.passwordHash);
      if (!ok) throw badRequest('Senha atual incorreta.');

      const passwordHash = await hashPassword(body.newPassword);
      await ctx.mongo.collections.users.updateOne(
        { _id: user._id },
        { $set: { passwordHash, updatedAt: new Date() } },
      );
      // Revoga as demais sessões do usuário.
      await ctx.mongo.collections.sessions.updateMany(
        { userId: user._id, _id: { $ne: auth.sessionId }, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      );
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'user.password_changed',
        entityType: 'user',
        entityId: user._id,
      });
      void reply;
      return { ok: true };
    },
  );

  /* ----------------------- esqueci a senha ------------------------- *
   * Resposta SEMPRE igual (exista ou não o e-mail). Token de uso único,
   * guardado só como hash, válido por 1 hora; no máximo 3 pedidos por
   * conta por hora (além do limite por IP).
   * ----------------------------------------------------------------- */
  app.post(
    '/auth/password/forgot',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request) => {
      const ctx = request.appCtx;
      const body = requestPasswordResetSchema.parse(request.body);
      const generic = {
        ok: true,
        message: 'Se o e-mail estiver cadastrado, enviaremos um link para redefinir a senha.',
      };
      const user = await ctx.mongo.collections.users.findOne({ emailLower: body.email });
      if (!user || user.status !== 'ACTIVE') return generic;

      const recent = await ctx.mongo.collections.passwordResets.countDocuments({
        userId: user._id,
        createdAt: { $gte: new Date(Date.now() - 3600 * 1000) },
      });
      if (recent >= PASSWORD_RESET_MAX_PER_HOUR) return generic;

      const token = generateToken(32);
      const now = new Date();
      await ctx.mongo.collections.passwordResets.insertOne({
        _id: new ObjectId(),
        userId: user._id,
        tokenHash: sha256(token),
        expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
        usedAt: null,
        createdAt: now,
      });
      const link = `${ctx.env.APP_URL.replace(/\/$/, '')}/redefinir-senha/${token}`;
      const result = await ctx.integrations.email.send(
        user.emailLower,
        'YuDirect — redefinição de senha',
        [
          `Olá, ${user.name}.`,
          '',
          'Recebemos um pedido para redefinir a senha da sua conta no YuDirect.',
          `Para criar uma nova senha, acesse (válido por 1 hora): ${link}`,
          '',
          'Se não foi você, ignore este e-mail — sua senha atual continua valendo.',
        ].join('\n'),
      );
      if (!result.delivered) request.log.warn({ error: result.error }, 'e-mail de redefinição não enviado');
      return generic;
    },
  );

  app.post(
    '/auth/password/reset',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request) => {
      const ctx = request.appCtx;
      const body = confirmPasswordResetSchema.parse(request.body);
      const now = new Date();
      // Claim atômico: o mesmo link não serve duas vezes, nem em paralelo.
      const reset = await ctx.mongo.collections.passwordResets.findOneAndUpdate(
        { tokenHash: sha256(body.token), usedAt: null, expiresAt: { $gt: now } },
        { $set: { usedAt: now } },
      );
      if (!reset) throw badRequest('Link inválido ou expirado. Peça um novo em "Esqueci a senha".');
      const user = await ctx.mongo.collections.users.findOne({ _id: reset.userId, status: 'ACTIVE' });
      if (!user) throw badRequest('Link inválido ou expirado. Peça um novo em "Esqueci a senha".');

      await ctx.mongo.collections.users.updateOne(
        { _id: user._id },
        { $set: { passwordHash: await hashPassword(body.password), updatedAt: now } },
      );
      // Quem tinha a senha antiga (ou um link antigo) perde o acesso.
      await ctx.mongo.collections.sessions.updateMany(
        { userId: user._id, revokedAt: null },
        { $set: { revokedAt: now } },
      );
      await ctx.mongo.collections.passwordResets.updateMany(
        { userId: user._id, usedAt: null },
        { $set: { usedAt: now } },
      );
      await ctx.mongo.collections.loginAttempts.deleteOne({ _id: user.emailLower });
      const membership = await ctx.mongo.collections.memberships.findOne({ userId: user._id, status: 'ACTIVE' });
      if (membership) {
        await audit(ctx, {
          organizationId: membership.organizationId,
          actorId: user._id,
          action: 'user.password_reset',
          entityType: 'user',
          entityId: user._id,
        });
      }
      return { ok: true };
    },
  );

  /* --------------------------- meu perfil -------------------------- */
  app.get('/profile', { onRequest: [app.requireAuth] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const [user, organization] = await Promise.all([
      ctx.mongo.collections.users.findOne({ _id: auth.userId }),
      ctx.mongo.collections.organizations.findOne({ _id: auth.organizationId }),
    ]);
    if (!user || !organization) throw notFound();
    return {
      id: user._id.toHexString(),
      name: user.name,
      email: user.emailLower,
      phone: user.phone,
      initials: initialsOf(user.name),
      role: auth.role,
      organization: { id: organization._id.toHexString(), name: organization.name },
      browserNotificationsEnabled: user.browserNotificationsEnabled,
      createdAt: user.createdAt.toISOString(),
    };
  });

  app.patch('/profile', { onRequest: [app.requireAuth] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const body = updateProfileRequestSchema.parse(request.body);
    await ctx.mongo.collections.users.updateOne(
      { _id: auth.userId },
      { $set: { name: body.name, phone: body.phone ?? null, updatedAt: new Date() } },
    );
    return { ok: true };
  });

  app.patch('/profile/notification-preferences', { onRequest: [app.requireAuth] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const body = notificationPreferencesRequestSchema.parse(request.body);
    await ctx.mongo.collections.users.updateOne(
      { _id: auth.userId },
      { $set: { browserNotificationsEnabled: body.browserNotificationsEnabled, updatedAt: new Date() } },
    );
    return { ok: true };
  });

  /* ------------------------ aceitar convite ------------------------ */
  app.get('/invitations/:token', async (request) => {
    const ctx = request.appCtx;
    const { token } = request.params as { token: string };
    const invitation = await ctx.mongo.collections.invitations.findOne({ tokenHash: sha256(token) });
    if (!invitation || invitation.status !== 'PENDING') throw notFound('Convite inválido ou já utilizado.');
    if (invitation.expiresAt.getTime() <= Date.now()) {
      await ctx.mongo.collections.invitations.updateOne(
        { _id: invitation._id },
        { $set: { status: 'EXPIRED', updatedAt: new Date() } },
      );
      throw conflict('Convite expirado. Solicite um novo ao administrador.');
    }
    const organization = await ctx.mongo.collections.organizations.findOne({
      _id: invitation.organizationId,
    });
    return {
      name: invitation.name,
      email: invitation.emailLower,
      organizationName: organization?.name ?? '—',
      // A tela pede "senha da sua conta" em vez de "crie uma senha".
      existingAccount: (await ctx.mongo.collections.users.countDocuments({ emailLower: invitation.emailLower })) > 0,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  });

  app.post(
    '/invitations/accept',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const ctx = request.appCtx;
      const body = acceptInvitationRequestSchema.parse(request.body);
      const invitation = await ctx.mongo.collections.invitations.findOne({
        tokenHash: sha256(body.token),
      });
      if (!invitation || invitation.status !== 'PENDING') throw notFound('Convite inválido ou já utilizado.');
      if (invitation.expiresAt.getTime() <= Date.now()) throw conflict('Convite expirado.');

      const now = new Date();
      let user = await ctx.mongo.collections.users.findOne({ emailLower: invitation.emailLower });
      if (user) {
        // Conta existente: quem aceita precisa provar que é o dono dela.
        // Sem isso, quem recebeu o link (inclusive quem convidou) entraria
        // como esse usuário.
        if (user.status !== 'ACTIVE' || !(await verifyPassword(body.password, user.passwordHash))) {
          await registerFailure(ctx, invitation.emailLower);
          throw forbidden('Este e-mail já tem uma conta. Informe a senha dessa conta para aceitar o convite.');
        }
      } else {
        const problem = passwordProblem(body.password);
        if (problem) throw badRequest(problem, { fieldErrors: { password: problem } });
        const passwordHash = await hashPassword(body.password);
        const _id = new ObjectId();
        await ctx.mongo.collections.users.insertOne({
          _id,
          name: body.name,
          emailLower: invitation.emailLower,
          passwordHash,
          phone: invitation.phone,
          status: 'ACTIVE',
          browserNotificationsEnabled: false,
          lastLoginAt: null,
          createdAt: now,
          updatedAt: now,
        });
        user = await ctx.mongo.collections.users.findOne({ _id });
      }
      if (!user) throw conflict('Não foi possível criar o usuário do convite.');

      // Claim atômico: dois aceites simultâneos do mesmo link → um vence.
      const claimed = await ctx.mongo.collections.invitations.findOneAndUpdate(
        { _id: invitation._id, status: 'PENDING' },
        { $set: { status: 'ACCEPTED', acceptedAt: now, updatedAt: now } },
        { returnDocument: 'after' },
      );
      if (!claimed) throw notFound('Convite inválido ou já utilizado.');

      const existing = await ctx.mongo.collections.memberships.findOne({
        organizationId: invitation.organizationId,
        userId: user._id,
      });
      if (existing && existing.role !== 'MEMBER') {
        // OWNER/ADMIN nunca é rebaixado por um convite; só reativa.
        await ctx.mongo.collections.memberships.updateOne(
          { _id: existing._id },
          { $set: { status: 'ACTIVE', updatedAt: now } },
        );
      } else {
        await ctx.mongo.collections.memberships.updateOne(
          { organizationId: invitation.organizationId, userId: user._id },
          {
            $set: { permissions: invitation.permissions, status: 'ACTIVE', updatedAt: now },
            $setOnInsert: {
              _id: new ObjectId(),
              organizationId: invitation.organizationId,
              userId: user._id,
              role: 'MEMBER',
              createdAt: now,
            },
          },
          { upsert: true },
        );
      }
      await audit(ctx, {
        organizationId: invitation.organizationId,
        actorId: user._id,
        action: 'invitation.accepted',
        entityType: 'invitation',
        entityId: invitation._id,
        after: { existingAccount: Boolean(existing) || undefined },
      });

      const token = generateToken(32);
      const expiresAt = new Date(Date.now() + ctx.env.SESSION_TTL_HOURS * 3600 * 1000);
      await ctx.mongo.collections.sessions.insertOne({
        _id: new ObjectId(),
        userId: user._id,
        organizationId: invitation.organizationId,
        tokenHash: sha256(token),
        createdAt: now,
        expiresAt,
        revokedAt: null,
        userAgent: request.headers['user-agent']?.slice(0, 200) ?? null,
        ip: request.ip ?? null,
      });
      reply.setCookie(ctx.env.SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: ctx.env.COOKIE_SECURE,
        path: '/',
        expires: expiresAt,
      });
      return { ok: true };
    },
  );
}
