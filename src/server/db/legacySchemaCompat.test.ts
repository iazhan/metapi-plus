import { describe, expect, it } from 'vitest';
import { classifyLegacyCompatMutation } from './legacySchemaCompat.js';

describe('legacy schema compat boundary', () => {
  it('allows only explicitly registered legacy upgrade shims', () => {
    expect(classifyLegacyCompatMutation('ALTER TABLE proxy_logs ADD COLUMN billing_details text;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE proxy_logs ADD COLUMN compatibility_notes text;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE proxy_logs ADD COLUMN is_stream integer;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE proxy_logs ADD COLUMN first_byte_latency_ms integer;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE proxy_logs ADD COLUMN client_app_id text;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('CREATE INDEX proxy_logs_client_app_id_created_at_idx ON proxy_logs(client_app_id, created_at);')).toBe('legacy');
    expect(classifyLegacyCompatMutation('UPDATE "sites" SET "use_system_proxy" = FALSE WHERE "use_system_proxy" IS NULL')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE sites ADD COLUMN responses_strip_image_generation_enabled integer NOT NULL DEFAULT 0;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('UPDATE sites SET responses_strip_image_generation_enabled = 0 WHERE responses_strip_image_generation_enabled IS NULL;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE sites ADD COLUMN brand_new_column text;')).toBe('forbidden');
    expect(classifyLegacyCompatMutation('UPDATE "sites" SET "brand_new_column" = 1')).toBe('forbidden');
  });
});
