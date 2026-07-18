import { describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as connectSocket, type AddressInfo } from 'node:net';
import { type Duplex } from 'node:stream';
import { SocksClient } from 'socks';
import { detectPlatform, getAdapter } from './index.js';
import { detectSite } from '../siteDetector.js';

async function withHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
  connectHandler?: (req: IncomingMessage, socket: Duplex) => void,
) {
  // Avoid flakiness: CPA uses port 8317 by convention, and our platform detection
  // includes a fast-path for localhost:8317. Random ephemeral ports can collide.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const server = createServer(handler);
    const sockets = new Set<Duplex>();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    if (connectHandler) {
      server.on('connect', (req, socket) => connectHandler(req, socket));
    }
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const { port } = server.address() as AddressInfo;
    if (port === 8317) {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
      continue;
    }

    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await run(baseUrl);
      return;
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  }

  throw new Error('withHttpServer: unable to allocate a test port that avoids 8317');
}

describe('getAdapter platform aliases', () => {
  it('maps legacy anyrouter alias to the new-api adapter', () => {
    const adapter = getAdapter('anyrouter');
    expect(adapter?.platformName).toBe('new-api');
  });

  it('handles case-insensitive platform strings', () => {
    const adapter = getAdapter('Veloera');
    expect(adapter?.platformName).toBe('veloera');
  });

  it('returns undefined for unknown platforms', () => {
    expect(getAdapter('unknown-platform')).toBeUndefined();
  });

  it('supports canonical openai/claude/gemini adapters', () => {
    expect(getAdapter('openai')?.platformName).toBe('openai');
    expect(getAdapter('claude')?.platformName).toBe('claude');
    expect(getAdapter('gemini')?.platformName).toBe('gemini');
  });

  it('does not expose retired native oauth platform adapters', () => {
    expect(getAdapter('codex')).toBeUndefined();
    expect(getAdapter('chatgpt-codex')).toBeUndefined();
    expect(getAdapter('gemini-cli')).toBeUndefined();
    expect(getAdapter('antigravity')).toBeUndefined();
    expect(getAdapter('anti-gravity')).toBeUndefined();
  });

  it('detects anyrouter URLs as new-api sites', async () => {
    const adapter = await detectPlatform('https://anyrouter.top');
    expect(adapter?.platformName).toBe('new-api');
  });

  it('detects done-hub URL before generic adapters', async () => {
    const adapter = await detectPlatform('https://demo.donehub.example');
    expect(adapter?.platformName).toBe('done-hub');
  });

  it('detects official openai/claude/gemini upstream URLs', async () => {
    const openai = await detectPlatform('https://api.openai.com');
    const claude = await detectPlatform('https://api.anthropic.com');
    const gemini = await detectPlatform('https://generativelanguage.googleapis.com');

    expect(openai?.platformName).toBe('openai');
    expect(claude?.platformName).toBe('claude');
    expect(gemini?.platformName).toBe('gemini');
  });

  it('detects one-hub by title under custom domain before generic new-api', async () => {
    await withHttpServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>One-Hub Console</title></head><body></body></html>');
        return;
      }
      if (req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: { system_name: 'New API' },
        }));
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const adapter = await detectPlatform(baseUrl);
      expect(adapter?.platformName).toBe('one-hub');
    });
  });

  it('detects done-hub by title under custom domain', async () => {
    await withHttpServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>Done-Hub Panel</title></head><body></body></html>');
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const adapter = await detectPlatform(baseUrl);
      expect(adapter?.platformName).toBe('done-hub');
    });
  });

  it('detects veloera by title under custom domain before generic new-api', async () => {
    await withHttpServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>Veloera 管理台</title></head><body></body></html>');
        return;
      }
      if (req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: { system_name: 'new-api fork' },
        }));
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const adapter = await detectPlatform(baseUrl);
      expect(adapter?.platformName).toBe('veloera');
    });
  });

  it('falls back to new-api by title when api/status is unavailable', async () => {
    await withHttpServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>Super-API Dashboard</title></head><body></body></html>');
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const adapter = await detectPlatform(baseUrl);
      expect(adapter?.platformName).toBe('new-api');
    });
  });

  it('keeps API status fallback available when the site root probe times out', async () => {
    await withHttpServer((req, res) => {
      if (req.url === '/api/status') {
        const body = JSON.stringify({
          success: true,
          data: { system_name: 'New API with a slow root page' },
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
        });
        res.end(body);
        return;
      }
      // Simulate an API-only deployment whose frontend root never completes.
      if (req.url === '/') return;
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const startedAt = Date.now();
      const adapter = await detectPlatform(baseUrl);

      expect(adapter?.platformName).toBe('new-api');
      expect(Date.now() - startedAt).toBeLessThan(15_000);
    });
  }, 17_000);

  it('detects a title-only platform through an explicit proxy context', async () => {
    await withHttpServer((_req, res) => {
      res.writeHead(502).end();
    }, async (proxyUrl) => {
      const adapter = await detectPlatform('http://unreachable-title.example', {
        siteProxy: { proxyUrl },
      });

      expect(adapter?.platformName).toBe('one-hub');
    }, (_req, socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', () => {
        const body = '<html><head><title>One-Hub Console</title></head></html>';
        socket.end([
          'HTTP/1.1 200 OK',
          'Content-Type: text/html; charset=utf-8',
          `Content-Length: ${Buffer.byteLength(body)}`,
          'Connection: close',
          '',
          body,
        ].join('\r\n'));
      });
    });
  });

  it('threads an explicit proxy context through site detection', async () => {
    await withHttpServer((_req, res) => {
      res.writeHead(502).end();
    }, async (proxyUrl) => {
      const result = await detectSite('http://unreachable-detect.invalid', {
        siteProxy: { proxyUrl },
      });

      expect(result).toMatchObject({
        url: 'http://unreachable-detect.invalid',
        platform: 'one-hub',
      });
    }, (_req, socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', () => {
        const body = '<html><head><title>One-Hub Console</title></head></html>';
        socket.end([
          'HTTP/1.1 200 OK',
          'Content-Type: text/html; charset=utf-8',
          `Content-Length: ${Buffer.byteLength(body)}`,
          'Connection: close',
          '',
          body,
        ].join('\r\n'));
      });
    });
  });

  it('routes CLIProxyAPI management probes through the detection proxy', async () => {
    await withHttpServer((_req, res) => {
      res.writeHead(502).end();
    }, async (proxyUrl) => {
      const adapter = await detectPlatform('http://unreachable-cpa.invalid', {
        siteProxy: { proxyUrl },
      });

      expect(adapter?.platformName).toBe('cliproxyapi');
    }, (_req, socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', (chunk) => {
        const request = chunk.toString('utf8');
        if (request.includes('/v0/management/openai-compatibility')) {
          socket.end([
            'HTTP/1.1 401 Unauthorized',
            'X-CPA-Version: test-version',
            'Content-Length: 0',
            'Connection: close',
            '',
            '',
          ].join('\r\n'));
          return;
        }
        socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      });
    });
  });

  it('routes Sub2API authentication probes through the detection proxy', async () => {
    await withHttpServer((_req, res) => {
      res.writeHead(502).end();
    }, async (proxyUrl) => {
      const adapter = await detectPlatform('http://unreachable-sub2.invalid', {
        siteProxy: { proxyUrl },
      });

      expect(adapter?.platformName).toBe('sub2api');
    }, (_req, socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', (chunk) => {
        const request = chunk.toString('utf8');
        if (request.includes('/api/v1/auth/me')) {
          const body = JSON.stringify({
            code: 'UNAUTHORIZED',
            message: 'Authorization header is required',
          });
          socket.end([
            'HTTP/1.1 401 Unauthorized',
            'Content-Type: application/json',
            `Content-Length: ${Buffer.byteLength(body)}`,
            'Connection: close',
            '',
            body,
          ].join('\r\n'));
          return;
        }
        socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      });
    });
  });

  it('routes Veloera status probes through the detection proxy before generic New API detection', async () => {
    await withHttpServer((_req, res) => {
      res.writeHead(502).end();
    }, async (proxyUrl) => {
      const adapter = await detectPlatform('http://unreachable-status-probe.invalid', {
        siteProxy: { proxyUrl },
      });

      expect(adapter?.platformName).toBe('veloera');
    }, (_req, socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', (chunk) => {
        const request = chunk.toString('utf8');
        if (request.includes('/api/status')) {
          const body = JSON.stringify({
            success: true,
            data: { system_name: 'Veloera' },
          });
          socket.end([
            'HTTP/1.1 200 OK',
            'Content-Type: application/json',
            `Content-Length: ${Buffer.byteLength(body)}`,
            'Connection: close',
            '',
            body,
          ].join('\r\n'));
          return;
        }
        socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      });
    });
  });

  it('routes One API status probes through the detection proxy', async () => {
    await withHttpServer((_req, res) => {
      res.writeHead(502).end();
    }, async (proxyUrl) => {
      const adapter = await detectPlatform('http://unreachable-one-api-probe.invalid', {
        siteProxy: { proxyUrl },
      });

      expect(adapter?.platformName).toBe('one-api');
    }, (_req, socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', (chunk) => {
        const request = chunk.toString('utf8');
        if (request.includes('/api/status')) {
          const body = JSON.stringify({ success: true, data: {} });
          socket.end([
            'HTTP/1.1 200 OK',
            'Content-Type: application/json',
            `Content-Length: ${Buffer.byteLength(body)}`,
            'Connection: close',
            '',
            body,
          ].join('\r\n'));
          return;
        }
        socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      });
    });
  });

  it('bounds the complete proxied detection flow with one shared deadline', async () => {
    await withHttpServer((_req, res) => {
      res.writeHead(502).end();
    }, async (proxyUrl) => {
      const startedAt = Date.now();
      const adapter = await detectPlatform('http://unreachable-timeout.invalid', {
        siteProxy: { proxyUrl },
      });

      expect(adapter).toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(12_000);
    }, () => {
      // Intentionally never complete the CONNECT handshake.
    });
  }, 12_000);

  it('keeps the internal detection deadline when the caller supplies a cancellation signal', async () => {
    await withHttpServer((req, res) => {
      if (req.url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: { system_name: 'New API' },
        }));
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
        .mockReturnValue(AbortSignal.abort(new DOMException('deadline', 'TimeoutError')));
      try {
        const callerController = new AbortController();
        const adapter = await detectPlatform(baseUrl, {
          signal: callerController.signal,
        });

        expect(adapter).toBeUndefined();
      } finally {
        timeoutSpy.mockRestore();
      }
    });
  });

  it('detects a platform through a SOCKS proxy dispatcher', async () => {
    const upstreamServer = createServer((request, response) => {
      response.setHeader('Connection', 'close');
      if (request.url === '/api/status') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          success: true,
          data: { system_name: 'New API through SOCKS' },
        }));
        return;
      }
      response.writeHead(404).end();
    });
    upstreamServer.listen(0, '127.0.0.1');
    await once(upstreamServer, 'listening');
    const address = upstreamServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to determine SOCKS detection upstream address');
    }

    const createConnectionSpy = vi.spyOn(SocksClient, 'createConnection').mockImplementation(async () => {
      const socket = connectSocket(address.port, '127.0.0.1');
      await once(socket, 'connect');
      return { socket } as Awaited<ReturnType<typeof SocksClient.createConnection>>;
    });

    try {
      const adapter = await detectPlatform(`http://socks-detect.example:${address.port}`, {
        siteProxy: {
          proxyUrl: 'socks5h://proxy-user:proxy-secret@127.0.0.1:1080',
        },
      });

      expect(adapter?.platformName).toBe('new-api');
      expect(createConnectionSpy).toHaveBeenCalledWith(expect.objectContaining({
        proxy: expect.objectContaining({
          host: '127.0.0.1',
          port: 1080,
          type: 5,
          userId: 'proxy-user',
          password: 'proxy-secret',
        }),
        destination: expect.objectContaining({
          host: 'socks-detect.example',
          port: address.port,
        }),
      }));
    } finally {
      createConnectionSpy.mockRestore();
      await new Promise<void>((resolve, reject) => {
        upstreamServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
