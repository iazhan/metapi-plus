import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function resolveSource(relativePath: string): URL {
  return new URL(relativePath, import.meta.url);
}

function readSource(relativePath: string): string {
  return readFileSync(resolveSource(relativePath), 'utf8');
}

describe('oauth retirement architecture', () => {
  it('removes oauth management and native-provider runtime modules', () => {
    for (const relativePath of [
      './routes/api/oauth.ts',
      './services/oauth',
      './proxy-core/providers/codexProviderProfile.ts',
      './proxy-core/providers/geminiCliProviderProfile.ts',
      './proxy-core/providers/antigravityProviderProfile.ts',
      './proxy-core/executors/geminiCliExecutor.ts',
      './proxy-core/executors/antigravityExecutor.ts',
      './services/platforms/codex.ts',
      './services/platforms/geminiCli.ts',
      './services/platforms/antigravity.ts',
    ]) {
      const path = resolveSource(relativePath);
      const exists = existsSync(path);
      const isEmptyDirectory = exists && statSync(path).isDirectory() && readdirSync(path).length === 0;
      expect(!exists || isEmptyDirectory, relativePath).toBe(true);
    }
  });

  it('keeps generic Claude, Responses, and Codex-client compatibility modules', () => {
    for (const relativePath of [
      './proxy-core/providers/claudeProviderProfile.ts',
      './transformers/openai/responses/codexCompatibility.ts',
      './shared/codexClientFamily.ts',
    ]) {
      expect(existsSync(resolveSource(relativePath)), relativePath).toBe(true);
    }
  });

  it('does not register oauth lifecycle or management routes', () => {
    const serverSource = readSource('./index.ts');
    const webSource = readSource('../web/App.tsx');

    expect(serverSource).not.toMatch(/oauthRoutes|startOAuthLoopback|ensureOauthProviderSitesExist|ensureOauthIdentityBackfill/);
    expect(webSource).not.toMatch(/OAuthManagement|to:\s*['"]\/oauth['"]|path=['"]\/oauth['"]/);
  });

  it('keeps downstream Responses websocket on the generic HTTP upstream path', () => {
    const websocketSource = readSource('./routes/proxy/responsesWebsocket.ts');

    expect(websocketSource).toContain('forwardResponsesRequestViaHttp');
    expect(websocketSource).toContain("url: '/v1/responses'");
    expect(websocketSource).not.toMatch(/codexWebsocketRuntime|codexSessionResponseStore|codexHttpSessionQueue/);
  });
});
