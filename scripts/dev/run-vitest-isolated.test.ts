import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createIsolatedVitestEnv } from './run-vitest-isolated.js';

describe('isolated vitest runner', () => {
  it('removes real sqlite targets inherited from the parent shell', () => {
    const repoDataDir = resolve(process.cwd(), 'data');
    const isolatedDataDir = resolve(process.cwd(), 'tmp', 'vitest-isolated');

    const env = createIsolatedVitestEnv({
      DATA_DIR: './data',
      DB_URL: './data/hub.db',
      DB_TYPE: 'postgres',
      NODE_ENV: 'development',
      KEEP_ME: 'yes',
    }, isolatedDataDir);

    expect(env.DATA_DIR).toBe(isolatedDataDir);
    expect(env.DB_TYPE).toBe('sqlite');
    expect(env.DB_URL).toBeUndefined();
    expect(env.NODE_ENV).toBe('test');
    expect(env.KEEP_ME).toBe('yes');
    expect(resolve(env.DATA_DIR)).not.toBe(repoDataDir);
    expect(resolve(env.DATA_DIR, 'hub.db')).not.toBe(resolve(process.cwd(), 'data', 'hub.db'));
  });

  it('keeps package vitest entrypoints behind the isolated runner', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts.test).toMatch(/^tsx scripts\/dev\/run-vitest-isolated\.ts run --root \./);
    expect(pkg.scripts['test:watch']).toMatch(/^tsx scripts\/dev\/run-vitest-isolated\.ts --root \./);

    for (const scriptName of [
      'test:schema:unit',
      'test:schema:parity',
      'test:schema:upgrade',
      'test:schema:runtime',
    ]) {
      expect(pkg.scripts[scriptName]).toMatch(/^tsx scripts\/dev\/run-vitest-isolated\.ts run --root \./);
    }
  });
});
