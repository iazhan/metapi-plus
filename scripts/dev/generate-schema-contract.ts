import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeDialectArtifactFiles } from '../../src/server/db/schemaArtifactGenerator.js';
import {
  type SchemaContract,
  writeSchemaContractFile,
} from '../../src/server/db/schemaContract.js';
import {
  compareStableSemVer,
  parseStableSemVer,
} from '../../src/server/services/updateCenterVersionService.js';

const GENERATED_CONTRACT_GIT_PATH = 'src/server/db/generated/schemaContract.json';
const SCHEMA_UPGRADE_BASE_REF_ENV = 'SCHEMA_UPGRADE_BASE_REF';

function readSchemaContractFromGitRef(ref: string): SchemaContract {
  let contractJson: string;
  try {
    contractJson = execFileSync(
      'git',
      ['-c', 'safe.directory=.', 'show', `${ref}:${GENERATED_CONTRACT_GIT_PATH}`],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
  } catch {
    throw new Error(
      `[schema:contract] failed to read schema upgrade baseline ref "${ref}" at ${GENERATED_CONTRACT_GIT_PATH}`,
    );
  }

  try {
    return JSON.parse(contractJson) as SchemaContract;
  } catch {
    throw new Error(
      `[schema:contract] schema upgrade baseline ref "${ref}" contains invalid JSON at ${GENERATED_CONTRACT_GIT_PATH}`,
    );
  }
}

function readCurrentPackageVersion(): ReturnType<typeof parseStableSemVer> {
  try {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { version?: string };
    return parseStableSemVer(packageJson.version);
  } catch {
    return null;
  }
}

function selectPreviousReleaseRef(): string | null {
  const explicitRef = String(process.env[SCHEMA_UPGRADE_BASE_REF_ENV] || '').trim();
  if (explicitRef) return explicitRef;

  const currentVersion = readCurrentPackageVersion();
  if (!currentVersion) return null;

  try {
    const tagOutput = execFileSync(
      'git',
      ['tag', '--list', 'v*', '--sort=-version:refname'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const [selectedRelease] = tagOutput
      .split(/\r?\n/)
      .map((tag) => ({ tag: tag.trim(), version: parseStableSemVer(tag) }))
      .filter((entry): entry is { tag: string; version: NonNullable<typeof entry.version> } => (
        !!entry.tag
        && !!entry.version
        && compareStableSemVer(entry.version, currentVersion) < 0
      ))
      .sort((left, right) => compareStableSemVer(right.version, left.version));
    return selectedRelease?.tag ?? null;
  } catch {
    return null;
  }
}

function readPreviousSchemaContract(): SchemaContract {
  const ref = selectPreviousReleaseRef();

  if (!ref) {
    throw new Error(
      `[schema:contract] schema upgrade baseline unavailable; fetch a previous release tag or set ${SCHEMA_UPGRADE_BASE_REF_ENV} to a ref containing ${GENERATED_CONTRACT_GIT_PATH}`,
    );
  }

  return readSchemaContractFromGitRef(ref);
}

const previousContract = readPreviousSchemaContract();
const contract = writeSchemaContractFile();
writeDialectArtifactFiles(contract, previousContract);
const tableCount = Object.keys(contract.tables).length;

console.log(`[schema:contract] wrote ${tableCount} tables and dialect artifacts`);
