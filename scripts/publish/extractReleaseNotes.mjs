import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeVersion(tag) {
  const version = String(tag || '').trim().replace(/^v/i, '');
  if (!version) {
    throw new Error('缺少发布 tag');
  }
  return version;
}

function hasReleaseContent(body) {
  const withoutComments = body.replace(/<!--[\s\S]*?-->/g, '');
  return withoutComments.split('\n').some((line) => {
    const value = line.trim();
    return value.length > 0 && !/^#{1,6}\s+/.test(value);
  });
}

/**
 * 从 CHANGELOG.md 中提取与 tag 完全匹配的版本段落。
 *
 * @param {string} changelog
 * @param {string} tag
 * @returns {string}
 */
export function extractReleaseNotes(changelog, tag) {
  const version = normalizeVersion(tag);
  const lines = String(changelog || '').replace(/\r\n?/g, '\n').split('\n');
  const versionHeading = new RegExp(`^##\\s+\\[${escapeRegExp(version)}\\](?:\\s+-\\s+.+)?\\s*$`);
  const startIndex = lines.findIndex((line) => versionHeading.test(line));
  if (startIndex < 0) {
    throw new Error(`CHANGELOG.md 缺少版本 ${version} 的更新日志`);
  }

  const nextSectionOffset = lines
    .slice(startIndex + 1)
    .findIndex((line) => /^##\s+/.test(line));
  const endIndex = nextSectionOffset < 0
    ? lines.length
    : startIndex + 1 + nextSectionOffset;
  const body = lines.slice(startIndex + 1, endIndex).join('\n').trim();
  if (!hasReleaseContent(body)) {
    throw new Error(`版本 ${version} 的更新日志没有实际内容`);
  }

  return `${body}\n`;
}

function parseCliArgs(argv) {
  const options = {
    tag: '',
    changelogPath: 'CHANGELOG.md',
    outputPath: 'release-notes.md',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--tag' || arg === '--changelog' || arg === '--output') {
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} 缺少参数值`);
      }
      if (arg === '--tag') options.tag = value;
      if (arg === '--changelog') options.changelogPath = value;
      if (arg === '--output') options.outputPath = value;
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }

  return options;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const changelog = await readFile(resolve(options.changelogPath), 'utf8');
  const releaseNotes = extractReleaseNotes(changelog, options.tag);
  await writeFile(resolve(options.outputPath), releaseNotes, 'utf8');
  process.stdout.write(`已生成 ${options.tag} 的 Release 更新日志：${options.outputPath}\n`);
}

const isDirectExecution = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
