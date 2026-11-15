import { config } from './config.js';

interface EmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>'"]/g,
    (character) =>
      (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }) as Record<string, string>)[character],
  );
const shell = (title: string, body: string): string =>
  `<!doctype html><html lang="es"><body style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.6"><div style="max-width:600px;margin:0 auto;padding:32px"><div style="font-size:22px;font-weight:700;color:#2563eb">ÁgoraHub</div><h1 style="font-size:26px">${title}</h1>${body}<p style="color:#64748b;font-size:13px;margin-top:32px">Este mensaje fue generado por ÁgoraHub. No respondas si no reconoces esta actividad.</p></div></body></html>`;

export const sendEmail = async (input: EmailInput): Promise<boolean> => {
  if (!config.resendApiKey || !config.emailFrom) {
    const missing = [...(!config.resendApiKey ? ['RESEND_API_KEY'] : []), ...(!config.emailFrom ? ['EMAIL_FROM'] : [])];
    console.warn('email_not_configured', { subject: input.subject, missing });
    return false;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': input.idempotencyKey,
    },
    body: JSON.stringify({
      from: config.emailFrom,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
  });
  if (!response.ok) {
    const error = await response.text();
    const senderGuidance =
      response.status === 403
        ? ' Verifica un dominio en Resend y configura EMAIL_FROM con un remitente de ese dominio.'
        : '';
    throw new Error(`Resend ${response.status}: ${error.slice(0, 500)}${senderGuidance}`);
  }
  return true;
};

const bestEffort = (input: EmailInput): void => {
  void sendEmail(input).catch((error: unknown) =>
    console.error('email_send_failed', error instanceof Error ? error.message : 'unknown error'),
  );
};

export const sendRequestCreatedEmail = (
  user: { email: string; fullName: string },
  request: { objective: string; modality: string },
): void => {
  bestEffort({
    to: user.email,
    subject: 'Recibimos tu solicitud de tutoría',
    html: shell(
      'Solicitud recibida',
      `<p>Hola ${escapeHtml(user.fullName)},</p><p>Recibimos tu solicitud para <strong>${escapeHtml(request.objective)}</strong> en modalidad ${escapeHtml(request.modality)}. Podrás revisar las respuestas desde Mis tutorías.</p>`,
    ),
    text: `Recibimos tu solicitud para ${request.objective} en modalidad ${request.modality}.`,
    idempotencyKey: `request-${request.objective.slice(0, 40)}-${Date.now()}`,
  });
};

export const sendProposalReceivedEmail = (
  user: { email: string; fullName: string },
  proposal: { message?: string | null; proposedHourlyRate: number },
): void => {
  bestEffort({
    to: user.email,
    subject: 'Recibiste una propuesta de tutoría',
    html: shell(
      'Tienes una nueva propuesta',
      `<p>Hola ${escapeHtml(user.fullName)},</p><p>Un tutor respondió a tu solicitud con una tarifa de <strong>$${proposal.proposedHourlyRate.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} por hora</strong>.</p>${proposal.message ? `<p>Mensaje: “${escapeHtml(proposal.message)}”</p>` : ''}<p>Entra a Mis tutorías para revisarla.</p>`,
    ),
    text: `Recibiste una propuesta de tutoría de $${proposal.proposedHourlyRate.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} por hora.`,
    idempotencyKey: `proposal-${Date.now()}-${proposal.proposedHourlyRate}`,
  });
};

export const sendSessionConfirmedEmail = (
  user: { email: string; fullName: string },
  details: { startsAt: string; role: string },
): void => {
  bestEffort({
    to: user.email,
    subject: 'Tu tutoría fue confirmada',
    html: shell(
      'Tutoría confirmada',
      `<p>Hola ${escapeHtml(user.fullName)},</p><p>La tutoría quedó confirmada para el <strong>${new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(details.startsAt))}</strong>.</p><p>El acceso al aula virtual aparecerá en Mis tutorías cuando la sesión sea online.</p>`,
    ),
    text: `Tu tutoría fue confirmada para ${new Date(details.startsAt).toLocaleString('es-CO')}.`,
    idempotencyKey: `session-${details.startsAt}-${user.email}-${details.role}`,
  });
};

export const sendSessionCancelledEmail = (
  user: { email: string; fullName: string },
  details: { startsAt: string; reason: string; cancelledBy: string },
): void => {
  const cancelledByLabel = details.cancelledBy === 'tutor' ? 'el profesor' : 'el estudiante';
  bestEffort({
    to: user.email,
    subject: 'Tu tutoría fue cancelada',
    html: shell(
      'Tutoría cancelada',
      `<p>Hola ${escapeHtml(user.fullName)},</p><p>La tutoría programada para el <strong>${new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(details.startsAt))}</strong> fue cancelada por ${cancelledByLabel}.</p><p><strong>Motivo:</strong> ${escapeHtml(details.reason)}</p><p>Si necesitas continuar, puedes crear una nueva solicitud desde Mis tutorías.</p>`,
    ),
    text: `La tutoría programada para ${new Date(details.startsAt).toLocaleString('es-CO')} fue cancelada por ${cancelledByLabel}. Motivo: ${details.reason}`,
    idempotencyKey: `session-cancelled-${details.startsAt}-${user.email}-${details.reason.slice(0, 40)}`,
  });
};

export const sendChatMessageEmail = (
  user: { email: string; fullName: string },
  details: { senderName: string; body: string },
): void => {
  bestEffort({
    to: user.email,
    subject: `Nuevo mensaje de ${details.senderName} en ÁgoraHub`,
    html: shell(
      'Tienes un nuevo mensaje',
      `<p>Hola ${escapeHtml(user.fullName)},</p><p><strong>${escapeHtml(details.senderName)}</strong> te escribió:</p><blockquote style="border-left:3px solid #2563eb;padding-left:14px">${escapeHtml(details.body)}</blockquote><p>Ingresa a Chat para responder.</p>`,
    ),
    text: `${details.senderName} te escribió: ${details.body}`,
    idempotencyKey: `chat-${user.email}-${Date.now()}`,
  });
};

export const sendRequestRejectedEmail = (
  user: { email: string; fullName: string },
  request: { objective: string; reason?: string | null },
): void => {
  const reasonHtml = request.reason ? `<p><strong>Motivo:</strong> ${escapeHtml(request.reason)}</p>` : '';
  const reasonText = request.reason ? ` Motivo: ${request.reason}` : '';
  bestEffort({
    to: user.email,
    subject: 'Tu solicitud de tutoría fue rechazada',
    html: shell(
      'Solicitud rechazada',
      `<p>Hola ${escapeHtml(user.fullName)},</p><p>El profesor no pudo tomar tu solicitud para <strong>${escapeHtml(request.objective)}</strong>.</p>${reasonHtml}<p>Puedes buscar otro tutor o crear una nueva solicitud desde Mis tutorías.</p>`,
    ),
    text: `El profesor no pudo tomar tu solicitud para ${request.objective}.${reasonText}`,
    idempotencyKey: `request-rejected-${user.email}-${request.objective.slice(0, 40)}-${Date.now()}`,
  });
};
