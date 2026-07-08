import { spawn } from 'node:child_process';
import process from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LocalCiProfile = 'verify' | 'ci';

export type LocalCiCommand = {
  label: string;
  command: string;
};

export type LocalCiPlan = {
  name: string;
  commands: LocalCiCommand[];
};

type RunCommandContext = {
  cwd: string;
};

type RunCommand = (command: LocalCiCommand, context: RunCommandContext) => Promise<number>;

type RunLocalCiOptions = LocalCiPlan & {
  cwd?: string;
  now?: () => number;
  runCommand?: RunCommand;
  log?: (message: string) => void;
  logError?: (message: string) => void;
};

const VERIFY_COMMANDS: LocalCiCommand[] = [
  { label: 'Full test suite', command: 'npm test' },
  { label: 'Typecheck', command: 'npm run typecheck' },
  { label: 'Build', command: 'npm run build' },
  { label: 'Docs build', command: 'npm run docs:build' },
  { label: 'Repo drift check', command: 'npm run repo:drift-check' },
  { label: 'Diff whitespace check', command: 'git diff --check' },
  { label: 'Git status', command: 'git status --short --branch' },
];

const SQLITE_SCHEMA_COMMANDS: LocalCiCommand[] = [
  { label: 'SQLite schema parity', command: 'npm run test:schema:parity' },
  { label: 'SQLite schema upgrade', command: 'npm run test:schema:upgrade' },
  { label: 'SQLite runtime schema bootstrap', command: 'npm run test:schema:runtime' },
];

export function createLocalCiPlan(profile: LocalCiProfile): LocalCiPlan {
  if (profile === 'verify') {
    return {
      name: 'Local Verification',
      commands: [...VERIFY_COMMANDS],
    };
  }

  return {
    name: 'Local CI',
    commands: [
      ...VERIFY_COMMANDS.slice(0, 5),
      ...SQLITE_SCHEMA_COMMANDS,
      ...VERIFY_COMMANDS.slice(5),
    ],
  };
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export async function defaultRunCommand(command: LocalCiCommand, context: RunCommandContext): Promise<number> {
  return new Promise((resolveExitCode) => {
    const child = spawn(command.command, {
      cwd: context.cwd,
      env: process.env,
      shell: true,
      stdio: 'inherit',
    });

    child.on('error', (error) => {
      console.error(`[local-ci] Failed to start "${command.command}": ${error.message}`);
      resolveExitCode(1);
    });

    child.on('close', (code) => {
      resolveExitCode(code ?? 1);
    });
  });
}

export async function runLocalCi(options: RunLocalCiOptions): Promise<number> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const now = options.now ?? Date.now;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const log = options.log ?? console.log;
  const logError = options.logError ?? console.error;
  const totalStart = now();

  log(`[local-ci] ${options.name}: ${options.commands.length} step(s)`);

  for (let index = 0; index < options.commands.length; index += 1) {
    const command = options.commands[index];
    const stepStart = now();

    log('');
    log(`[local-ci] ${index + 1}/${options.commands.length} ${command.label}`);
    log(`> ${command.command}`);

    const exitCode = await runCommand(command, { cwd });
    const elapsed = formatDuration(now() - stepStart);

    if (exitCode !== 0) {
      logError(`[local-ci] Failed: ${command.label} exited with ${exitCode} after ${elapsed}`);
      return exitCode;
    }

    log(`[local-ci] Passed: ${command.label} in ${elapsed}`);
  }

  log('');
  log(`[local-ci] ${options.name} finished in ${formatDuration(now() - totalStart)}`);
  return 0;
}

function parseProfile(argv: string[]): LocalCiProfile {
  const profile = argv[0] ?? 'verify';
  if (profile === 'verify' || profile === 'ci') {
    return profile;
  }
  throw new Error(`Unknown local CI profile "${profile}". Expected "verify" or "ci".`);
}

const isMainModule = (() => {
  try {
    return process.argv[1] != null && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  try {
    const profile = parseProfile(process.argv.slice(2));
    const exitCode = await runLocalCi(createLocalCiPlan(profile));
    process.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[local-ci] ${message}`);
    process.exit(1);
  }
}
