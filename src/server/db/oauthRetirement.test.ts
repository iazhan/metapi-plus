import { describe, expect, it } from 'vitest';
import { isChatGptCodexSite, resolveRetiredSiteAction } from './oauthRetirement.js';

describe('OAuth retirement site classification', () => {
  it('matches only the official HTTPS ChatGPT Codex endpoint and its URL suffixes', () => {
    expect(isChatGptCodexSite('codex', 'https://chatgpt.com/backend-api/codex')).toBe(true);
    expect(isChatGptCodexSite('codex', 'https://chatgpt.com/backend-api/codex?tenant=official')).toBe(true);
    expect(isChatGptCodexSite('codex', 'https://chatgpt.com/backend-api/codex/')).toBe(true);
    expect(isChatGptCodexSite('codex', 'https://chatgpt.com/backend-api/codex-extra')).toBe(false);
    expect(isChatGptCodexSite('codex', 'http://chatgpt.com/backend-api/codex')).toBe(false);
    expect(isChatGptCodexSite('codex', 'https://chatgpt.com.evil.example/backend-api/codex')).toBe(false);
    expect(isChatGptCodexSite('openai', 'https://chatgpt.com/backend-api/codex')).toBe(false);
  });

  it('deletes retired native sites but keeps or reclassifies compatible API sites', () => {
    expect(resolveRetiredSiteAction('gemini-cli', 'https://example.com')).toBe('delete');
    expect(resolveRetiredSiteAction('antigravity', 'https://example.com')).toBe('delete');
    expect(resolveRetiredSiteAction('codex', 'https://chatgpt.com/backend-api/codex')).toBe('delete');
    expect(resolveRetiredSiteAction('codex', 'https://workspace.example.com/v1')).toBe('reclassify-openai');
    expect(resolveRetiredSiteAction('claude', 'https://api.anthropic.com')).toBe('keep');
  });
});
