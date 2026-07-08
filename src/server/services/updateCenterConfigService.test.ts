import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          get: () => undefined,
        }),
      }),
    }),
  },
  schema: {
    settings: {
      key: 'key',
    },
  },
}));

vi.mock('../db/upsertSetting.js', () => ({
  upsertSetting: vi.fn(),
}));

import {
  getDefaultUpdateCenterConfig,
  normalizeUpdateCenterConfig,
} from './updateCenterConfigService.js';

describe('update center config service', () => {
  it('defaults new installs to the Metapi Plus GHCR image repository and container tag source', () => {
    expect(getDefaultUpdateCenterConfig()).toMatchObject({
      imageRepository: 'ghcr.io/iazhan/metapi-plus',
      defaultDeploySource: 'github-release',
      dockerHubTagsEnabled: true,
    });
  });

  it('normalizes legacy Docker Hub source values to the neutral container tag source', () => {
    expect(normalizeUpdateCenterConfig({
      imageRepository: '',
      defaultDeploySource: 'docker-hub-tag',
    })).toMatchObject({
      imageRepository: 'ghcr.io/iazhan/metapi-plus',
      defaultDeploySource: 'container-tag',
    });
  });
});
