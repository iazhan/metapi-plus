import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('docker workflows', () => {
  it('publishes armv7 docker images in ci and release workflows', () => {
    const ciWorkflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    const releaseWorkflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8');

    expect(ciWorkflow).toContain('arch: armv7');
    expect(ciWorkflow).toContain('platform: linux/arm/v7');
    expect(ciWorkflow).toContain('"${tag}-armv7"');

    expect(releaseWorkflow).toContain('arch: armv7');
    expect(releaseWorkflow).toContain('platform: linux/arm/v7');
    expect(releaseWorkflow).toContain('"${tag}-armv7"');
  });

  it('publishes GHCR image names from the repository owner', () => {
    const ciWorkflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    const releaseWorkflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8');

    expect(ciWorkflow).toContain('GHCR_IMAGE: ghcr.io/${{ github.repository_owner }}/metapi-plus');
    expect(ciWorkflow).not.toContain('DOCKERHUB_IMAGE');
    expect(ciWorkflow).not.toContain('DOCKERHUB_USERNAME');
    expect(ciWorkflow).not.toContain('images: 1467078763/metapi');

    expect(releaseWorkflow).toContain('GHCR_IMAGE: ghcr.io/${{ github.repository_owner }}/metapi-plus');
    expect(releaseWorkflow).not.toContain('DOCKERHUB_IMAGE');
    expect(releaseWorkflow).not.toContain('DOCKERHUB_USERNAME');
    expect(releaseWorkflow).not.toContain('1467078763/metapi');
  });

  it('reserves the GHCR latest tag for release workflows', () => {
    const ciWorkflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    const releaseWorkflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8');

    expect(ciWorkflow).not.toContain('type=raw,value=latest');
    expect(releaseWorkflow).toContain('type=raw,value=latest');
  });

  it('uses the Metapi Plus GHCR image in bundled deployment templates', () => {
    const compose = readFileSync(resolve(process.cwd(), 'docker/docker-compose.yml'), 'utf8');
    const deployHelper = readFileSync(resolve(process.cwd(), 'deploy/k3s/metapi-deploy-helper.yaml'), 'utf8');
    const chartValues = readFileSync(resolve(process.cwd(), 'deploy/k3s/chart/values.yaml'), 'utf8');

    expect(compose).toContain('image: ghcr.io/iazhan/metapi-plus:latest');
    expect(compose).not.toContain('1467078763/metapi');
    expect(deployHelper).toContain('image: ghcr.io/iazhan/metapi-plus:latest');
    expect(deployHelper).not.toContain('1467078763/metapi');
    expect(chartValues).toContain('repository: ghcr.io/iazhan/metapi-plus');
    expect(chartValues).not.toContain('1467078763/metapi');
  });

  it('uses an armv7-capable node base image in the Dockerfile', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'docker/Dockerfile'), 'utf8');

    expect(dockerfile).toContain('FROM node:22-bookworm-slim AS builder');
    expect(dockerfile).toContain('FROM node:22-bookworm-slim');
  });

  it('avoids buildkit-only frontend syntax so managed docker builders can parse it reliably', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'docker/Dockerfile'), 'utf8');

    expect(dockerfile).not.toContain('# syntax=docker/dockerfile:');
    expect(dockerfile).not.toContain('RUN --mount=type=cache');
  });

  it('keeps server docker builds isolated from desktop packaging dependencies', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'docker/Dockerfile'), 'utf8');

    expect(dockerfile).toContain('npm ci --ignore-scripts --no-audit --no-fund');
    expect(dockerfile).toContain('npm rebuild esbuild sharp better-sqlite3 --no-audit --no-fund');
    expect(dockerfile).not.toContain('npm ci --no-audit --no-fund');
    expect(dockerfile).toContain('RUN npm run build:web && npm run build:server');
    expect(dockerfile).toContain('npm prune --omit=dev --no-audit --no-fund');
  });
});
