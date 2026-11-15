import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.js';

export type JsonRecord = Record<string, unknown>;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const setCors = (res: ServerResponse): void => {
  res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
};

export const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
};

export const sendData = (res: ServerResponse, data: unknown, status = 200): void => {
  sendJson(res, status, { data });
};

export const sendError = (res: ServerResponse, error: unknown): void => {
  if (error instanceof HttpError) {
    sendJson(res, error.status, {
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }
  console.error('api_error', error instanceof Error ? error.message : error);
  sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error inesperado.' } });
};

export const readJson = async <T extends JsonRecord>(req: IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000)
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'El cuerpo de la petición es demasiado grande.');
    chunks.push(buffer);
  }
  if (size === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'El cuerpo debe ser JSON válido.');
  }
};

export const bearerToken = (req: IncomingMessage): string => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError(401, 'AUTH_REQUIRED', 'Debes iniciar sesión para realizar esta acción.');
  }
  return header.slice('Bearer '.length).trim();
};

export const requireString = (value: unknown, field: string, min = 1, max = 500): string => {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new HttpError(400, 'INVALID_FIELD', `El campo ${field} no es válido.`);
  }
  return value.trim();
};

export const optionalString = (value: unknown, max = 500): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim().length > max) {
    throw new HttpError(400, 'INVALID_FIELD', 'Uno de los campos de texto no es válido.');
  }
  return value.trim();
};

export const requireNumber = (value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new HttpError(400, 'INVALID_FIELD', `El campo ${field} debe ser numérico.`);
  }
  return number;
};
