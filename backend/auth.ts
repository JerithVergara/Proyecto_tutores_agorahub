import type { IncomingMessage } from 'node:http';
import { db, supabaseAdmin, supabaseAuth } from './supabase.js';
import { config } from './config.js';
import { sendWelcomeEmail } from './email.js';
import { bearerToken, HttpError, optionalString, requireString } from './http.js';

export type Role = 'student' | 'tutor' | 'admin';

export interface CurrentUser {
  id: string;
  email: string;
  fullName: string;
  phone?: string;
  avatar_url?: string | null;
  role: Role;
  status: string;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const namePattern = /^[A-Za-zÁÉÍÓÚáéíóúÑñÜü ]{2,120}$/;
const phonePattern = /^[+0-9 ()-]{7,30}$/;

const profileFor = async (id: string, emailFromAuth?: string): Promise<CurrentUser> => {
  const [{ data: profile, error: profileError }, { data: memberships, error: rolesError }] = await Promise.all([
    db.from('users').select('id, email, full_name, phone, avatar_url, status').eq('id', id).maybeSingle(),
    db.from('user_roles').select('role_id').eq('user_id', id),
  ]);
  if (profileError)
    throw new HttpError(
      500,
      'PROFILE_LOOKUP_FAILED',
      'No se pudo consultar el perfil de usuario.',
      profileError.message,
    );
  if (rolesError)
    throw new HttpError(500, 'ROLE_LOOKUP_FAILED', 'No se pudo consultar el rol de usuario.', rolesError.message);
  if (!profile)
    throw new HttpError(403, 'PROFILE_NOT_FOUND', 'El usuario autenticado no tiene un perfil de aplicación.');

  const roleIds = (memberships ?? []).map((row: { role_id: number }) => row.role_id);
  const { data: roles, error: roleError } = roleIds.length
    ? await db.from('roles').select('id, code').in('id', roleIds)
    : { data: [], error: null };
  if (roleError)
    throw new HttpError(500, 'ROLE_LOOKUP_FAILED', 'No se pudo resolver el rol de usuario.', roleError.message);
  const roleCodes = (roles ?? []).map((item: { code: string }) => item.code.toLowerCase());
  const role: Role | '' = roleCodes.includes('admin')
    ? 'admin'
    : roleCodes.some((code) => ['tutor', 'teacher', 'professor', 'profesor', 'instructor'].includes(code))
      ? 'tutor'
      : roleCodes.some((code) => ['student', 'learner', 'estudiante'].includes(code))
        ? 'student'
        : '';
  if (!role) throw new HttpError(403, 'ROLE_NOT_ASSIGNED', 'El usuario no tiene un rol válido.');

  return {
    id: profile.id,
    email: profile.email ?? emailFromAuth ?? '',
    fullName: profile.full_name,
    phone: profile.phone ?? undefined,
    avatar_url: profile.avatar_url ?? null,
    role,
    status: profile.status,
  };
};

export const register = async (body: Record<string, unknown>) => {
  const email = requireString(body.email, 'email', 5, 160).toLowerCase();
  const password = requireString(body.password, 'password', 8, 72);
  const fullName = requireString(body.fullName, 'fullName', 2, 120);
  const rawRole = requireString(body.role, 'role', 4, 20).toLowerCase();
  const roleAliases: Record<string, Role> = {
    student: 'student',
    estudiante: 'student',
    learner: 'student',
    tutor: 'tutor',
    profesor: 'tutor',
    teacher: 'tutor',
    instructor: 'tutor',
  };
  const role = roleAliases[rawRole];
  if (!emailPattern.test(email)) throw new HttpError(400, 'INVALID_EMAIL', 'Escribe un correo electrónico válido.');
  if (!namePattern.test(fullName))
    throw new HttpError(400, 'INVALID_NAME', 'El nombre solo puede contener letras y espacios.');
  if (!role || !['student', 'tutor'].includes(role))
    throw new HttpError(400, 'INVALID_ROLE', 'El rol seleccionado no es válido. Usa estudiante o tutor.');

  const phone = optionalString(body.phone, 30);
  if (phone && !phonePattern.test(phone))
    throw new HttpError(
      400,
      'INVALID_PHONE',
      'El teléfono solo puede contener números, espacios, guiones, paréntesis y el signo +.',
    );
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: !config.authRequireEmailConfirmation,
    user_metadata: { full_name: fullName, role },
  });
  if (authError || !authData.user) {
    throw new HttpError(409, 'AUTH_REGISTRATION_FAILED', authError?.message ?? 'No se pudo crear la cuenta.');
  }

  const userId = authData.user.id;
  try {
    const { data: roleRow, error: roleError } = await db.from('roles').select('id').eq('code', role).single();
    if (roleError || !roleRow)
      throw new HttpError(500, 'ROLE_NOT_CONFIGURED', 'El rol solicitado no existe en la base de datos.');

    const { error: userError } = await db.from('users').insert({
      id: userId,
      email,
      full_name: fullName,
      phone: phone ?? null,
      status: 'active',
    });
    if (userError) {
      throw new HttpError(
        500,
        'PROFILE_CREATE_FAILED',
        'No se pudo crear el perfil de aplicación. Ejecuta la migración de Supabase Auth si la columna password_hash sigue siendo obligatoria.',
        userError.message,
      );
    }

    const { error: membershipError } = await db.from('user_roles').insert({ user_id: userId, role_id: roleRow.id });
    if (membershipError)
      throw new HttpError(500, 'ROLE_ASSIGN_FAILED', 'No se pudo asignar el rol al usuario.', membershipError.message);

    const profileTable = role === 'student' ? 'student_profiles' : 'tutor_profiles';
    const profilePayload: Record<string, unknown> =
      role === 'student'
        ? {
            user_id: userId,
            education_level: optionalString(body.educationLevel, 80) ?? null,
            learning_goal: optionalString(body.learningGoal, 160) ?? null,
          }
        : {
            user_id: userId,
            professional_title: optionalString(body.professionalTitle, 120) ?? null,
            bio: optionalString(body.bio, 1000) ?? null,
            teaching_modality: typeof body.teachingModality === 'string' ? body.teachingModality : 'both',
            service_area: optionalString(body.serviceArea, 160) ?? null,
            verification_status: 'pending',
          };
    const { error: profileError } = await db.from(profileTable).insert(profilePayload);
    if (profileError)
      throw new HttpError(
        500,
        'ROLE_PROFILE_CREATE_FAILED',
        'No se pudo crear el perfil específico del rol.',
        profileError.message,
      );
    if (role === 'tutor') {
      const educationLevel = optionalString(body.educationLevel, 80);
      if (educationLevel) {
        const { data: levels, error: levelsError } = await db
          .from('education_levels')
          .select('id, name')
          .eq('is_active', true);
        if (levelsError)
          throw new HttpError(
            500,
            'EDUCATION_LEVEL_LOOKUP_FAILED',
            'No se pudieron consultar los niveles educativos.',
            levelsError.message,
          );
        const selectedLevels =
          educationLevel === 'Todos los niveles'
            ? (levels ?? [])
            : (levels ?? []).filter((level: { name: string }) => level.name === educationLevel);
        if (selectedLevels.length) {
          const { error: tutorLevelsError } = await db
            .from('tutor_education_levels')
            .insert(
              selectedLevels.map((level: { id: number }) => ({ tutor_id: userId, education_level_id: level.id })),
            );
          if (tutorLevelsError)
            throw new HttpError(
              500,
              'TUTOR_LEVELS_CREATE_FAILED',
              'No se pudieron guardar los niveles que enseña el tutor.',
              tutorLevelsError.message,
            );
        }
      }
      const title = optionalString(body.professionalTitle, 120);
      if (title) {
        const { data: existingSubject, error: subjectLookupError } = await db
          .from('subjects')
          .select('id')
          .ilike('name', title)
          .maybeSingle();
        if (subjectLookupError)
          throw new HttpError(
            500,
            'SUBJECT_LOOKUP_FAILED',
            'No se pudo consultar la materia principal.',
            subjectLookupError.message,
          );
        let subjectId = existingSubject?.id;
        if (!subjectId) {
          const { data: subject, error: subjectInsertError } = await db
            .from('subjects')
            .insert({ name: title, is_active: true })
            .select('id')
            .single();
          if (subjectInsertError)
            throw new HttpError(
              500,
              'SUBJECT_CREATE_FAILED',
              'No se pudo guardar la materia principal.',
              subjectInsertError.message,
            );
          subjectId = subject.id;
        }
        const { error: tutorSubjectError } = await db
          .from('tutor_subjects')
          .insert({ tutor_id: userId, subject_id: subjectId, is_primary: true });
        if (tutorSubjectError)
          throw new HttpError(
            500,
            'TUTOR_SUBJECT_CREATE_FAILED',
            'No se pudo asociar la materia principal al tutor.',
            tutorSubjectError.message,
          );
      }
    }
  } catch (error) {
    await supabaseAdmin.auth.admin.deleteUser(userId);
    throw error;
  }

  const user = await profileFor(userId, email);
  let welcomeEmailSent = false;
  try {
    welcomeEmailSent = await sendWelcomeEmail(user);
  } catch (error) {
    console.error('welcome_email_send_failed', error instanceof Error ? error.message : 'unknown error');
  }
  const { data: sessionData } = await supabaseAuth.auth.signInWithPassword({ email, password });
  return {
    user,
    accessToken: sessionData.session?.access_token,
    refreshToken: sessionData.session?.refresh_token,
    expiresAt: sessionData.session?.expires_at,
    requiresEmailConfirmation: !sessionData.session,
    welcomeEmailSent,
    message: !welcomeEmailSent
      ? 'La cuenta se creó correctamente, pero no se pudo enviar el correo de bienvenida. Revisa la configuración de correo.'
      : sessionData.session
        ? 'Cuenta creada correctamente.'
        : 'Cuenta creada. Revisa tu correo para confirmar el acceso.',
  };
};

export const login = async (body: Record<string, unknown>) => {
  const email = requireString(body.email, 'email', 5, 160).toLowerCase();
  const password = requireString(body.password, 'password', 8, 72);
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user)
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'El correo o la contraseña no son válidos.');
  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at,
    user: await profileFor(data.user.id, data.user.email),
  };
};

export const refresh = async (body: Record<string, unknown>) => {
  const refreshToken = requireString(body.refreshToken, 'refreshToken', 8, 5000);
  const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session || !data.user)
    throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'La sesión expiró. Inicia sesión nuevamente.');
  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at,
    user: await profileFor(data.user.id, data.user.email),
  };
};

const recoveryRedirect = (req: IncomingMessage, requested?: unknown): string => {
  if (typeof requested === 'string' && requested.length <= 1000) {
    try {
      const parsed = new URL(requested);
      const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '')
        .split(',')[0]
        .trim();
      const requestOrigin = `${forwardedProto || 'http'}://${req.headers.host || 'localhost:3000'}`;
      const configuredOrigin = config.appUrl ? new URL(config.appUrl).origin : requestOrigin;
      if (
        ['http:', 'https:'].includes(parsed.protocol) &&
        parsed.pathname.endsWith('/pages/reset-password.html') &&
        [requestOrigin, configuredOrigin].includes(parsed.origin)
      )
        return parsed.toString();
    } catch {
      // Usa la URL configurada como respaldo.
    }
  }
  if (config.appUrl) return `${config.appUrl}/pages/reset-password.html`;
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim();
  const protocol = forwardedProto || 'http';
  const host = req.headers.host || 'localhost:3000';
  return `${protocol}://${host}/pages/reset-password.html`;
};

export const requestPasswordReset = async (req: IncomingMessage, body: Record<string, unknown>) => {
  const email = requireString(body.email, 'email', 5, 160).toLowerCase();
  if (!emailPattern.test(email)) throw new HttpError(400, 'INVALID_EMAIL', 'Escribe un correo electrónico válido.');
  const { error } = await supabaseAuth.auth.resetPasswordForEmail(email, {
    redirectTo: recoveryRedirect(req, body.redirectTo),
  });
  if (error)
    throw new HttpError(
      502,
      'PASSWORD_RESET_UNAVAILABLE',
      'No se pudo enviar el correo de recuperación. Revisa la configuración de correo de Supabase.',
    );
  return { message: 'Si el correo está registrado, recibirás un enlace para recuperar tu contraseña.' };
};

export const exchangeRecoveryCode = async (body: Record<string, unknown>) => {
  const code = requireString(body.code, 'code', 10, 2000);
  const { data, error } = await supabaseAuth.auth.exchangeCodeForSession(code);
  if (error || !data.session || !data.user)
    throw new HttpError(401, 'INVALID_RECOVERY_LINK', 'El enlace de recuperación no es válido o ya expiró.');
  return { accessToken: data.session.access_token, refreshToken: data.session.refresh_token, user: data.user };
};

export const updatePassword = async (req: IncomingMessage, body: Record<string, unknown>) => {
  const user = await currentUser(req);
  const password = requireString(body.password, 'password', 8, 72);
  const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, { password });
  if (error)
    throw new HttpError(
      502,
      'PASSWORD_UPDATE_FAILED',
      'No se pudo actualizar la contraseña. Solicita un enlace nuevo e inténtalo otra vez.',
    );
  return { message: 'Contraseña actualizada correctamente.' };
};

export const currentUser = async (req: IncomingMessage): Promise<CurrentUser> => {
  const token = bearerToken(req);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'INVALID_SESSION', 'La sesión no es válida o ya expiró.');
  return profileFor(data.user.id, data.user.email);
};

export const requireRole = (user: CurrentUser, roles: Role[]): void => {
  if (!roles.includes(user.role)) throw new HttpError(403, 'FORBIDDEN', 'Tu rol no puede realizar esta acción.');
  if (user.status !== 'active') throw new HttpError(403, 'USER_INACTIVE', 'La cuenta no está activa.');
};
