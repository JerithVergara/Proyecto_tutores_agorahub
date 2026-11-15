import { config } from './config.js';
import { HttpError } from './http.js';

export type AssistantMessage = { role: 'user' | 'assistant' | 'system'; content: string };
type ChatCompletionResponse = { error?: { message?: unknown }; choices?: Array<{ message?: { content?: unknown } }> };

export const generateAssistantReply = async (
  messages: AssistantMessage[],
): Promise<{ content: string; model: string; provider: 'xai' | 'groq' }> => {
  if (!config.aiApiKey) {
    const keyName = config.aiProvider === 'xai' ? 'XAI_API_KEY' : 'GROQ_API_KEY';
    throw new HttpError(
      503,
      'AI_NOT_CONFIGURED',
      `El Asistente IA no está configurado: falta ${keyName} en el entorno del backend.`,
    );
  }
  const providerName = config.aiProvider === 'xai' ? 'Grok (xAI)' : 'Groq';
  let response: Response;
  try {
    response = await fetch(`${config.aiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.aiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.aiModel,
        messages: [
          {
            role: 'system',
            content:
              'Eres el Asistente IA educativo de ÁgoraHub. Responde en español claro, cálido y preciso. Ayuda a comprender conceptos, preparar planes de estudio, resumir textos y formular preguntas para un tutor. No inventes fuentes ni afirmes haber hecho acciones externas. No resuelvas evaluaciones para copiar; explica el procedimiento y fomenta el aprendizaje. Mantén respuestas prácticas y de máximo 700 palabras.',
          },
          ...messages.slice(-20),
        ],
        temperature: 0.35,
        ...(config.aiProvider === 'xai' ? { max_completion_tokens: 900 } : { max_tokens: 900 }),
      }),
    });
  } catch (error) {
    console.error(
      'ai_provider_connection_failed',
      config.aiProvider,
      error instanceof Error ? error.message : 'unknown error',
    );
    throw new HttpError(
      502,
      'AI_PROVIDER_UNAVAILABLE',
      `No se pudo conectar con ${providerName}. Revisa la conexión y la configuración del proveedor.`,
    );
  }
  let body: ChatCompletionResponse;
  try {
    body = (await response.json()) as ChatCompletionResponse;
  } catch {
    throw new HttpError(502, 'AI_INVALID_RESPONSE', `${providerName} devolvió una respuesta que no se pudo leer.`);
  }
  if (!response.ok) {
    const providerMessage = typeof body.error?.message === 'string' ? body.error.message : '';
    console.error('ai_provider_request_failed', config.aiProvider, response.status, providerMessage);
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(
        502,
        'AI_INVALID_API_KEY',
        `La clave de ${providerName} no es válida o no tiene acceso al modelo.`,
      );
    }
    if (response.status === 404) {
      throw new HttpError(
        502,
        'AI_MODEL_NOT_FOUND',
        `El modelo ${config.aiModel} no está disponible en ${providerName}.`,
      );
    }
    if (response.status === 429) {
      throw new HttpError(502, 'AI_RATE_LIMITED', `${providerName} alcanzó su límite de uso. Inténtalo más tarde.`);
    }
    throw new HttpError(502, 'AI_PROVIDER_ERROR', `${providerName} devolvió un error (${response.status}).`);
  }
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new HttpError(502, 'AI_EMPTY_RESPONSE', `${providerName} devolvió una respuesta vacía.`);
  }
  return { content: content.trim(), model: config.aiModel, provider: config.aiProvider };
};
