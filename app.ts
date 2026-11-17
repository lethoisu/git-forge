// HTTP server: routing, auth, body handling. The trial's suite talks to
// this server only; no browser ever does.
//
// Routes:
//   GET  /healthz                      -> {"ok": true} (no auth)
//   POST /mcp                          -> MCP JSON-RPC
//   POST /api/graphql                  -> GraphQL v4
//   /api/v3/*                          -> REST v3
//   /<owner>/<repo>.git/*              -> git smart HTTP
//   anything else                      -> 404 JSON
//
// Auth: every API call must present `Authorization: Bearer
// <MAKEFUN_SHOP_TOKEN>` (the token the trial puts in the entry's env).
// Missing or wrong token is 401. When the token env var is unset (local
// development only) auth is skipped.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { executeGraphQL } from './graphql.ts';
import {
  applyPush,
  fetchResponseV0,
  fetchResponseV2,
  lsRefsResponse,
  parseReceivePack,
  parseUploadPack,
  pushReportResponse,
  receivePackAdvertisement,
  uploadPackAdvertisement,
} from './gitproto.ts';
import { handleMcp } from './mcp.ts';
import { routeRest } from './rest.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, store: Store, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': store.nextRequestId(),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendBuffer(res: ServerResponse, store: Store, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': store.nextRequestId(),
    'content-length': body.length,
  });
  res.end(body);
}

export function createApp(): Server {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer((req, res) => {
    void handle(req, res, store, expectedToken).catch((err) => {
      console.error('[entry]', err instanceof Error ? err.stack ?? err.message : String(err));
      if (!res.headersSent) sendJson(res, store, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse, store: Store, expectedToken: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const method = req.method ?? 'GET';
  const host = req.headers.host ?? 'localhost';
  const baseUrl = `http://${host}`;

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, store, 200, { ok: true });
    return;
  }

  // -- auth (everything except /healthz) -------------------------------------
  if (expectedToken !== '') {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${expectedToken}`) {
      sendJson(res, store, 401, { message: 'Bad credentials' });
      return;
    }
  }

  // -- MCP --------------------------------------------------------------------
  if (pathname === '/mcp') {
    if (method === 'DELETE') {
      res.writeHead(204, { 'x-github-request-id': store.nextRequestId() });
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, store, 405, { message: 'Method Not Allowed' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, store, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const result = handleMcp(store, parsed);
    if (result.status === 202) {
      res.writeHead(202, { 'x-github-request-id': store.nextRequestId(), ...(result.headers ?? {}) });
      res.end();
      return;
    }
    sendJson(res, store, result.status, result.body, result.headers);
    return;
  }

  // -- GraphQL ------------------------------------------------------------------
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, store, 405, { message: 'Method Not Allowed' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, store, 400, { message: 'Invalid JSON' });
      return;
    }
    const result = executeGraphQL(store, parsed);
    sendJson(res, store, 200, result);
    return;
  }

  // -- REST v3 --------------------------------------------------------------------
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const restPath = pathname === '/api/v3' ? '' : pathname.slice('/api/v3/'.length);
    const segments = restPath === '' ? [] : restPath.split('/').filter((s) => s.length > 0);
    let parsed: unknown = undefined;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, store, 400, { message: 'Invalid JSON' });
          return;
        }
      }
    }
    const result = routeRest({ store, baseUrl }, method, segments, url.searchParams, parsed);
    sendJson(res, store, result.status, result.body, result.headers);
    return;
  }

  // -- git smart HTTP ---------------------------------------------------------------
  const gitMatch = pathname.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)?$/);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const suffix = gitMatch[3] ?? '';
    if (owner !== store.viewer) {
      sendJson(res, store, 404, { message: 'Not Found' });
      return;
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      sendJson(res, store, 404, { message: 'Not Found' });
      return;
    }
    const isV2 = req.headers['git-protocol'] === 'version=2';

    if (method === 'GET' && suffix === '/info/refs') {
      const service = url.searchParams.get('service');
      if (service === 'git-upload-pack') {
        sendBuffer(res, store, 200, uploadPackAdvertisement(repo, isV2), 'application/x-git-upload-pack-advertisement');
        return;
      }
      if (service === 'git-receive-pack') {
        sendBuffer(res, store, 200, receivePackAdvertisement(repo), 'application/x-git-receive-pack-advertisement');
        return;
      }
      sendJson(res, store, 400, { message: 'service parameter is required' });
      return;
    }

    if (method === 'POST' && suffix === '/git-upload-pack') {
      const raw = await readBody(req);
      try {
        const parsed = parseUploadPack(raw, isV2);
        let out: Buffer;
        if (parsed.command === 'ls-refs') {
          out = lsRefsResponse(repo, parsed.lsRefsArgs!);
        } else if (parsed.command === 'fetch' || parsed.protocol === 0) {
          const fetchReq = parsed.fetch!;
          out = isV2 ? fetchResponseV2(repo, fetchReq) : fetchResponseV0(repo, fetchReq);
        } else {
          throw new Error('unsupported upload-pack command');
        }
        sendBuffer(res, store, 200, out, 'application/x-git-upload-pack-result');
      } catch (err) {
        sendJson(res, store, 400, { message: err instanceof Error ? err.message : 'malformed request' });
      }
      return;
    }

    if (method === 'POST' && suffix === '/git-receive-pack') {
      const raw = await readBody(req);
      try {
        const { commands, pack, sideband } = parseReceivePack(raw);
        const { results, unpackOk, unpackError } = applyPush(repo, commands, pack);
        const out = pushReportResponse(results, unpackOk, unpackError, sideband);
        sendBuffer(res, store, 200, out, 'application/x-git-receive-pack-result');
      } catch (err) {
        sendJson(res, store, 400, { message: err instanceof Error ? err.message : 'malformed request' });
      }
      return;
    }

    sendJson(res, store, 404, { message: 'Not Found' });
    return;
  }

  // -- unknown route ------------------------------------------------------------------
  sendJson(res, store, 404, { message: 'Not Found' });
}
