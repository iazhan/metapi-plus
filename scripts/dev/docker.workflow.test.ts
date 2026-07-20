import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function extractSection(source: string, start: string, end?: string): string {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) throw new Error(`Missing section: ${start}`);
  const endIndex = end ? source.indexOf(end, startIndex + start.length) : source.length;
  if (end && endIndex < 0) throw new Error(`Missing section terminator: ${end}`);
  return source.slice(startIndex, endIndex);
}

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

  it('keeps CI images on GHCR and publishes release images to GHCR and Docker Hub', () => {
    const ciWorkflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    const releaseWorkflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8');
    const releaseArchJob = extractSection(
      releaseWorkflow,
      '  publish-docker-arch:',
      '  publish-docker:',
    );
    const releaseManifestJob = extractSection(releaseWorkflow, '  publish-docker:');

    expect(ciWorkflow).toContain('GHCR_IMAGE: ghcr.io/${{ github.repository_owner }}/metapi-plus');
    expect(ciWorkflow).not.toContain('DOCKERHUB_IMAGE');
    expect(ciWorkflow).not.toContain('DOCKERHUB_USERNAME');
    expect(ciWorkflow).not.toContain('images: 1467078763/metapi');

    for (const job of [releaseArchJob, releaseManifestJob]) {
      expect(job).toContain('GHCR_IMAGE: ghcr.io/${{ github.repository_owner }}/metapi-plus');
      expect(job).toContain(
        'DOCKERHUB_IMAGE: docker.io/${{ secrets.DOCKERHUB_USERNAME }}/metapi-plus',
      );
      expect(job).toContain('Login to Docker Hub');
      expect(job).toContain('username: ${{ secrets.DOCKERHUB_USERNAME }}');
      expect(job).toContain('password: ${{ secrets.DOCKERHUB_TOKEN }}');
      expect(job).toContain('images: |');
      expect(job).toContain('${{ env.GHCR_IMAGE }}');
      expect(job).toContain('${{ env.DOCKERHUB_IMAGE }}');
    }
    expect(releaseWorkflow).not.toContain('1467078763/metapi');
  });

  it('can mirror an existing GHCR release to Docker Hub without rebuilding it', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '.github/workflows/dockerhub-backfill.yml'),
      'utf8',
    );
    const sourceTagInput = extractSection(workflow, '      source_tag:', '      publish_latest:');
    const publishLatestInput = extractSection(workflow, '      publish_latest:', 'permissions:');
    const versionStep = extractSection(
      workflow,
      '      - name: Mirror version tag',
      '      - name: Mirror latest tag',
    );
    const latestStep = extractSection(workflow, '      - name: Mirror latest tag');

    expect(workflow).toContain('workflow_dispatch:');
    expect(sourceTagInput).not.toContain('default:');
    expect(publishLatestInput).toContain('default: false');
    expect(workflow).toContain('SOURCE_IMAGE: ghcr.io/${{ github.repository_owner }}/metapi-plus');
    expect(workflow).toContain(
      'TARGET_IMAGE: docker.io/${{ secrets.DOCKERHUB_USERNAME }}/metapi-plus',
    );
    expect(workflow).toContain('Login to GitHub Container Registry');
    expect(workflow).toContain('Login to Docker Hub');
    expect(workflow).toContain('Validate source tag');
    expect(workflow).toContain('^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$');
    for (const step of [versionStep, latestStep]) {
      expect(step).toContain('skopeo copy --all');
      expect(step).toContain('--src-authfile "$HOME/.docker/config.json"');
      expect(step).toContain('--dest-authfile "$HOME/.docker/config.json"');
      expect(step).toContain('"docker://${SOURCE_IMAGE}:${SOURCE_TAG}"');
    }
    expect(versionStep).toContain('"docker://${TARGET_IMAGE}:${SOURCE_TAG}"');
    expect(latestStep).toContain('if: inputs.publish_latest');
    expect(latestStep).toContain('"docker://${TARGET_IMAGE}:latest"');
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

  it('uses one Metapi Plus service name across bundled Compose tooling', () => {
    const compose = readFileSync(resolve(process.cwd(), 'docker/docker-compose.yml'), 'utf8');
    const override = readFileSync(resolve(process.cwd(), 'docker/docker-compose.override.yml'), 'utf8');
    const updateScript = readFileSync(resolve(process.cwd(), 'update-and-restart.sh'), 'utf8');

    expect(compose).toMatch(/^  metapi-plus:/m);
    expect(override).toMatch(/^  metapi-plus:/m);
    expect(override).not.toMatch(/^  metapi:/m);
    expect(updateScript).toContain('port metapi-plus 4000');
    expect(updateScript).not.toContain('port metapi 4000');
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

  it('uses an exec-form entrypoint so the server receives container signals', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'docker/Dockerfile'), 'utf8');

    expect(dockerfile).toContain('ENTRYPOINT ["/app/docker-entrypoint.sh"]');
    expect(dockerfile).not.toContain('CMD ["sh", "-c"');
  });
});
