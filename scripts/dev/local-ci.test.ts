import { describe, expect, it, vi } from 'vitest';
import {
  createLocalCiPlan,
  runLocalCi,
  type LocalCiCommand,
} from './local-ci.js';

describe('local ci runner', () => {
  it('builds the local verification gate in the expected order', () => {
    const plan = createLocalCiPlan('verify');

    expect(plan.name).toBe('Local Verification');
    expect(plan.commands.map((command) => command.label)).toEqual([
      'Full test suite',
      'Typecheck',
      'Build',
      'Docs build',
      'Repo drift check',
      'Diff whitespace check',
      'Git status',
    ]);
    expect(plan.commands.map((command) => command.command)).toEqual([
      'npm test',
      'npm run typecheck',
      'npm run build',
      'npm run docs:build',
      'npm run repo:drift-check',
      'git diff --check',
      'git status --short --branch',
    ]);
  });

  it('adds sqlite schema checks to the local ci profile', () => {
    const plan = createLocalCiPlan('ci');

    expect(plan.name).toBe('Local CI');
    expect(plan.commands.map((command) => command.command)).toEqual([
      'npm test',
      'npm run typecheck',
      'npm run build',
      'npm run docs:build',
      'npm run repo:drift-check',
      'npm run test:schema:parity',
      'npm run test:schema:upgrade',
      'npm run test:schema:runtime',
      'git diff --check',
      'git status --short --branch',
    ]);
  });

  it('stops at the first failed command', async () => {
    const calls: string[] = [];
    const commands: LocalCiCommand[] = [
      { label: 'First', command: 'first command' },
      { label: 'Second', command: 'second command' },
      { label: 'Third', command: 'third command' },
    ];
    const runCommand = vi.fn(async (command: LocalCiCommand) => {
      calls.push(command.command);
      return command.command === 'second command' ? 1 : 0;
    });

    const exitCode = await runLocalCi({
      name: 'Test Plan',
      commands,
      runCommand,
      now: () => 1_000,
      log: () => undefined,
      logError: () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(calls).toEqual(['first command', 'second command']);
  });
});
