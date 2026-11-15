import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { extname, normalize, resolve, sep } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { config } from './config.js';
import { handleApi } from './routes.js';
import { sendError, setCors, HttpError } from './http.js';

const projectRoot = process.cwd();
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const safeFilePath = (pathname: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'La ruta no es válida.');
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = resolve(projectRoot, normalize(relative));
  if (candidate !== projectRoot && !candidate.startsWith(`${projectRoot}${sep}`)) {
    throw new HttpError(403, 'FORBIDDEN', 'Ruta no permitida.');
  }
  return candidate;
};

const findStaticFile = async (pathname: string): Promise<string> => {
  const requested = safeFilePath(pathname);
  const candidates = [requested];
  if (pathname === '/manus-routes.json') candidates.push(resolve(projectRoot, 'public/manus-routes.json'));
  if (pathname.startsWith('/public/')) candidates.push(resolve(projectRoot, pathname.slice(1)));
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Try the next static candidate.
    }
  }
  throw new HttpError(404, 'NOT_FOUND', 'Recurso no encontrado.');
};

const serveStatic = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const filePath = await findStaticFile(pathname);
  res.statusCode = 200;
  res.setHeader('Content-Type', contentTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
};

const server = createServer(async (req, res) => {
  setCors(res);
  try {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res);
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method ?? ''))
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Método no permitido.');
    await serveStatic(req, res);
  } catch (error) {
    sendError(res, error);
  }
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`tutoreshub-api listening on 0.0.0.0:${config.port}`);
});
