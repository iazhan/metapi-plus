import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { OneHubAdapter } from './oneHub.js';
import { OneApiAdapter } from './oneApi.js';
import { DoneHubAdapter } from './doneHub.js';

describe('OneHubAdapter', () => {
  let server: ReturnType<typeof createServer> | undefined;
  let baseUrl: string;

  afterEach(async () => {
    if (server) {
      const s = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => {
        s.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    return new Promise<void>((resolve) => {
      server = createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const addr = server!.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  it('falls back to /api/available_model when /v1/models fails', async () => {
    await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (req.url === '/api/available_model') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: {
            'gpt-4o': { price: { input: 0.5, output: 1.5 } },
            'claude-3-opus': { price: { input: 1, output: 3 } },
          },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const adapter = new OneHubAdapter();
    const models = await adapter.getModels(baseUrl, 'token');
    expect(models).toEqual(expect.arrayContaining(['gpt-4o', 'claude-3-opus']));
  });

  it('returns user groups from /api/user_group_map', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/user_group_map') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { default: 1.0, vip: 0.8 } }));
        return;
      }
      res.writeHead(404).end();
    });

    const adapter = new OneHubAdapter();
    const groups = await adapter.getUserGroups(baseUrl, 'token');
    expect(groups).toEqual(expect.arrayContaining(['default', 'vip']));
  });

  it('parses token list from {data: [...]} envelope', async () => {
    await startServer((req, res) => {
      if (req.url?.startsWith('/api/token/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [
            { key: 'sk-hub-abc', name: 'my-token', status: 1, id: 1 },
          ],
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const adapter = new OneHubAdapter();
    const tokens = await adapter.getApiTokens(baseUrl, 'token');
    expect(tokens.length).toBe(1);
    expect(tokens[0].key).toBe('sk-hub-abc');
  });

  it('aborts the active token-list fetch instead of accepting its later response', async () => {
    let requestStarted = false;
    await startServer((req, res) => {
      if (req.url?.startsWith('/api/token/')) {
        requestStarted = true;
        setTimeout(() => {
          if (res.destroyed || res.writableEnded) return;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [{ key: 'late-token', status: 1 }] }));
        }, 50);
        return;
      }
      res.writeHead(404).end();
    });
    const adapter = new OneHubAdapter();
    const controller = new AbortController();
    const pending = adapter.getApiTokens(baseUrl, 'token', undefined, controller.signal);

    await vi.waitFor(() => expect(requestStarted).toBe(true));
    controller.abort(new Error('cancel one-api token request'));

    await expect(pending).rejects.toThrow('cancel one-api token request');
  });

  it.each([
    { platform: 'OneAPI', createAdapter: () => new OneApiAdapter(), status: 401 },
    { platform: 'OneAPI', createAdapter: () => new OneApiAdapter(), status: 403 },
    { platform: 'OneAPI', createAdapter: () => new OneApiAdapter(), status: 500 },
    { platform: 'OneHub', createAdapter: () => new OneHubAdapter(), status: 401 },
    { platform: 'OneHub', createAdapter: () => new OneHubAdapter(), status: 403 },
    { platform: 'OneHub', createAdapter: () => new OneHubAdapter(), status: 500 },
    { platform: 'DoneHub', createAdapter: () => new DoneHubAdapter(), status: 401 },
    { platform: 'DoneHub', createAdapter: () => new DoneHubAdapter(), status: 403 },
    { platform: 'DoneHub', createAdapter: () => new DoneHubAdapter(), status: 500 },
  ])('$platform propagates HTTP $status from token listing', async ({ createAdapter, status }) => {
    await startServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: `status ${status}` }));
    });

    await expect(createAdapter().getApiTokens(baseUrl, 'token'))
      .rejects.toThrow(new RegExp(`HTTP ${status}`));
  });

  it.each([
    { platform: 'OneAPI', createAdapter: () => new OneApiAdapter() },
    { platform: 'OneHub', createAdapter: () => new OneHubAdapter() },
    { platform: 'DoneHub', createAdapter: () => new DoneHubAdapter() },
  ])('$platform rejects success:false from token listing', async ({ createAdapter }) => {
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'token listing disabled' }));
    });

    await expect(createAdapter().getApiTokens(baseUrl, 'token'))
      .rejects.toThrow(/token listing disabled/i);
  });

  it.each([
    { platform: 'OneAPI', createAdapter: () => new OneApiAdapter() },
    { platform: 'OneHub', createAdapter: () => new OneHubAdapter() },
    { platform: 'DoneHub', createAdapter: () => new DoneHubAdapter() },
  ])('$platform accepts a structurally valid empty token list', async ({ createAdapter }) => {
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { items: [] } }));
    });

    await expect(createAdapter().getApiTokens(baseUrl, 'token')).resolves.toEqual([]);
  });
});
