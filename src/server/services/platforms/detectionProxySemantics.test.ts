import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

type DbModule = typeof import('../../db/index.js');

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('platform detection proxy semantics', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let detectPlatform: typeof import('./index.js')['detectPlatform'];
  let invalidateSiteProxyCache: typeof import('../siteProxy.js')['invalidateSiteProxyCache'];

  beforeAll(async () => {
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const platformModule = await import('./index.js');
    const siteProxyModule = await import('../siteProxy.js');
    db = dbModule.db;
    schema = dbModule.schema;
    detectPlatform = platformModule.detectPlatform;
    invalidateSiteProxyCache = siteProxyModule.invalidateSiteProxyCache;
  });

  beforeEach(async () => {
    await db.delete(schema.accounts).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.sites).run();
    invalidateSiteProxyCache();
  });

  afterAll(async () => {
    await db.delete(schema.accounts).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.sites).run();
    invalidateSiteProxyCache();
  });

  it('uses a direct connection when no detection proxy context is supplied', async () => {
    const upstreamSockets = new Set<Socket>();
    const upstream = createServer((request, response) => {
      if (request.url === '/api/status') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          success: true,
          data: { system_name: 'Direct New API' },
        }));
        return;
      }
      response.writeHead(404).end();
    });
    upstream.on('connection', (socket) => {
      upstreamSockets.add(socket);
      socket.once('close', () => upstreamSockets.delete(socket));
    });

    const proxySockets = new Set<Socket>();
    const unavailableProxy = createServer((_request, response) => {
      response.writeHead(502).end();
    });
    unavailableProxy.on('connection', (socket) => {
      proxySockets.add(socket);
      socket.once('close', () => proxySockets.delete(socket));
    });
    unavailableProxy.on('connect', (_request, socket) => {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });

    const upstreamUrl = await listen(upstream);
    const proxyUrl = await listen(unavailableProxy);

    try {
      await db.insert(schema.sites).values({
        name: 'saved-proxy-site',
        url: upstreamUrl,
        platform: 'new-api',
        proxyUrl,
      }).run();
      invalidateSiteProxyCache();

      const adapter = await detectPlatform(upstreamUrl);

      expect(adapter?.platformName).toBe('new-api');
    } finally {
      await close(unavailableProxy, proxySockets);
      await close(upstream, upstreamSockets);
    }
  });
});
