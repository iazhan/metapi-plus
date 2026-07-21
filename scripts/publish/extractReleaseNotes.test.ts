import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractReleaseNotes } from './extractReleaseNotes.mjs';

const tempDirs: string[] = [];

const changelog = `# 更新日志

## [Unreleased]

### 修复

- 尚未发布的修复。

## [2.3.0] - 2026-08-01

### 新增

- 新增用户可见功能。

### 修复

- 修复一个重要问题。

## [2.2.3] - 2026-07-25

### 修复

- 修复较早版本的问题。
`;

describe('extractReleaseNotes', () => {
  it('extracts only the changelog section matching the release tag', () => {
    expect(extractReleaseNotes(changelog, 'v2.3.0')).toBe(`### 新增

- 新增用户可见功能。

### 修复

- 修复一个重要问题。
`);
  });

  it('rejects a release tag without a matching changelog section', () => {
    expect(() => extractReleaseNotes(changelog, 'v2.4.0'))
      .toThrow('CHANGELOG.md 缺少版本 2.4.0 的更新日志');
  });

  it('rejects a version section that contains headings but no release notes', () => {
    expect(() => extractReleaseNotes(`# 更新日志

## [2.4.0] - 2026-08-02

    ### 修复
`, 'v2.4.0')).toThrow('版本 2.4.0 的更新日志没有实际内容');
  });

  it('writes release notes through the workflow CLI arguments', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'metapi-release-notes-'));
    tempDirs.push(tempDir);
    const changelogPath = join(tempDir, 'CHANGELOG.md');
    const outputPath = join(tempDir, 'release-notes.md');
    writeFileSync(changelogPath, changelog, 'utf8');

    execFileSync(process.execPath, [
      resolve(process.cwd(), 'scripts/publish/extractReleaseNotes.mjs'),
      '--tag',
      'v2.3.0',
      '--changelog',
      changelogPath,
      '--output',
      outputPath,
    ]);

    expect(readFileSync(outputPath, 'utf8')).toContain('- 新增用户可见功能。');
    expect(readFileSync(outputPath, 'utf8')).not.toContain('较早版本');
  });
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
});
