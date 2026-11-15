import { config } from './config.js';
export class HttpError extends Error {
    status;
    code;
    details;
    constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
export const setCors = (res) => {
    res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
};
export const sendJson = (res, status, body) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
};
export const sendData = (res, data, status = 200) => {
    sendJson(res, status, { data });
};
export const sendError = (res, error) => {
    if (error instanceof HttpError) {
        sendJson(res, error.status, {
            error: { code: error.code, message: error.message, details: error.details },
        });
        return;
    }
    console.error('api_error', error instanceof Error ? error.message : error);
    sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error inesperado.' } });
};
export const readJson = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 1_000_000)
            throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'El cuerpo de la petición es demasiado grande.');
        chunks.push(buffer);
    }
    if (size === 0)
        return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new HttpError(400, 'INVALID_JSON', 'El cuerpo debe ser JSON válido.');
    }
};
export const bearerToken = (req) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
        throw new HttpError(401, 'AUTH_REQUIRED', 'Debes iniciar sesión para realizar esta acción.');
    }
    return header.slice('Bearer '.length).trim();
};
export const requireString = (value, field, min = 1, max = 500) => {
    if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
        throw new HttpError(400, 'INVALID_FIELD', `El campo ${field} no es válido.`);
    }
    return value.trim();
};
export const optionalString = (value, max = 500) => {
    if (value === undefined || value === null || value === '')
        return undefined;
    if (typeof value !== 'string' || value.trim().length > max) {
        throw new HttpError(400, 'INVALID_FIELD', 'Uno de los campos de texto no es válido.');
    }
    return value.trim();
};
export const requireNumber = (value, field, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
        throw new HttpError(400, 'INVALID_FIELD', `El campo ${field} debe ser numérico.`);
    }
    return number;
};