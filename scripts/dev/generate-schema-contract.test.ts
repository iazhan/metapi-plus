import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SchemaContract } from '../../src/server/db/schemaContract.js';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeDialectArtifactFiles: vi.fn(),
  writeSchemaContractFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: mocks.execFileSync,
}));

vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
}));

vi.mock('../../src/server/db/schemaArtifactGenerator.js', () => ({
  writeDialectArtifactFiles: mocks.writeDialectArtifactFiles,
}));

vi.mock('../../src/server/db/schemaContract.js', () => ({
  resolveGeneratedSchemaContractPath: () => 'src/server/db/generated/schemaContract.json',
  writeSchemaContractFile: mocks.writeSchemaContractFile,
}));

const committedContract: SchemaContract = {
  tables: {},
  indexes: [],
  uniques: [],
  foreignKeys: [],
};

const workingContract: SchemaContract = {
  tables: {
    account_group_rates: {
      columns: {},
    },
  },
  indexes: [],
  uniques: [],
  foreignKeys: [],
};

describe('schema contract generator baseline', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.SCHEMA_UPGRADE_BASE_REF;
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockImplementation((path: string) => (
      String(path).endsWith('package.json')
        ? JSON.stringify({ version: '1.5.0' })
        : JSON.stringify(workingContract)
    ));
    mocks.writeSchemaContractFile.mockReturnValue(workingContract);
  });

  it('uses the newest release tag older than the package version after HEAD already contains the new contract', async () => {
    mocks.execFileSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'tag') return 'v1.5.0\nv1.4.0\n';
      if (args[0] === '-c' && args[2] === 'show') {
        return args[3].startsWith('v1.4.0:')
          ? JSON.stringify(committedContract)
          : JSON.stringify(workingContract);
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    });

    await import('./generate-schema-contract.js');

    expect(mocks.writeDialectArtifactFiles).toHaveBeenCalledWith(
      workingContract,
      committedContract,
      { allowedColumnRemovals: ['accounts.unit_cost'] },
    );
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['show', 'v1.4.0:src/server/db/generated/schemaContract.json']),
      expect.any(Object),
    );
  });

  it('uses an explicit schema upgrade base ref ahead of automatic release tags', async () => {
    process.env.SCHEMA_UPGRADE_BASE_REF = 'v1.3.0';
    mocks.execFileSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'tag') return 'v1.4.0\n';
      if (args[0] === '-c' && args[2] === 'show') {
        return args[3].startsWith('v1.3.0:')
          ? JSON.stringify(committedContract)
          : JSON.stringify(workingContract);
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    });

    await import('./generate-schema-contract.js');

    expect(mocks.writeDialectArtifactFiles).toHaveBeenCalledWith(
      workingContract,
      committedContract,
      { allowedColumnRemovals: ['accounts.unit_cost'] },
    );
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['show', 'v1.3.0:src/server/db/generated/schemaContract.json']),
      expect.any(Object),
    );
  });

  it('fails before writing when the newest previous release contract is invalid instead of falling back', async () => {
    mocks.execFileSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'tag') return 'v1.4.0\nv1.3.0\n';
      if (args[0] === '-c' && args[2] === 'show') {
        if (args[3].startsWith('v1.4.0:')) return '{not valid JSON';
        if (args[3].startsWith('v1.3.0:')) return JSON.stringify(committedContract);
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    });

    await expect(import('./generate-schema-contract.js')).rejects.toThrow(
      /v1\.4\.0.*src\/server\/db\/generated\/schemaContract\.json/i,
    );

    expect(mocks.execFileSync).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['show', 'v1.3.0:src/server/db/generated/schemaContract.json']),
      expect.any(Object),
    );
    expect(mocks.writeSchemaContractFile).not.toHaveBeenCalled();
    expect(mocks.writeDialectArtifactFiles).not.toHaveBeenCalled();
  });

  it('reports an unreadable explicit baseline ref and contract path before writing', async () => {
    const explicitRef = 'refs/heads/missing-schema-baseline';
    const sensitiveGitDetail = 'SENSITIVE_GIT_DIAGNOSTIC';
    process.env.SCHEMA_UPGRADE_BASE_REF = explicitRef;
    mocks.execFileSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === '-c' && args[2] === 'show') {
        throw new Error(sensitiveGitDetail);
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    });

    const error = await import('./generate-schema-contract.js').then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(explicitRef);
    expect((error as Error).message).toContain(
      'src/server/db/generated/schemaContract.json',
    );
    expect((error as Error).message).not.toContain(sensitiveGitDetail);
    expect((error as Error).message).not.toMatch(/set SCHEMA_UPGRADE_BASE_REF/i);
    expect(mocks.writeSchemaContractFile).not.toHaveBeenCalled();
    expect(mocks.writeDialectArtifactFiles).not.toHaveBeenCalled();
  });

  it('fails before writing artifacts when no previous release tag or explicit baseline is available', async () => {
    mocks.execFileSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'tag') return '';
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    });

    await expect(import('./generate-schema-contract.js')).rejects.toThrow(
      /schema upgrade baseline.*SCHEMA_UPGRADE_BASE_REF/i,
    );

    expect(mocks.writeSchemaContractFile).not.toHaveBeenCalled();
    expect(mocks.writeDialectArtifactFiles).not.toHaveBeenCalled();
  });
});
