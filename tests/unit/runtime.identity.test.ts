import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  computeDaemonId,
  normalizeEnv,
  normalizeCommand,
  deriveIdentityEnv
} from '../../src/daemon/runtime.ts';

describe('runtime identity', () => {
  it('normalizeEnv sorts keys and coerces values', () => {
    const env = normalizeEnv({ B: '2', A: 1 as unknown as string });
    const keys = Object.keys(env);
    expect(keys).toEqual(['A', 'B']);
    expect(env.A).toBe('1');
    expect(env.B).toBe('2');
  });

  it('deriveIdentityEnv ignores ambient process.env and uses only explicit env', () => {
    const explicit = { FOO: 'x', BAR: 'y' };
    const derived = deriveIdentityEnv(explicit);
    expect(derived).toEqual(normalizeEnv(explicit));
    // Ensure no accidental merge from process.env
    for (const k of Object.keys(process.env)) {
      expect(Object.prototype.hasOwnProperty.call(derived, k)).toBe(false);
    }
  });

  it('computeDaemonId is stable regardless of env key ordering', () => {
    const cmd = '/usr/bin/node';
    const args = ['/path/to/server.js'];
    const env1 = { A: '1', B: '2' };
    const env2 = { B: '2', A: '1' };
    const id1 = computeDaemonId(cmd, args, env1);
    const id2 = computeDaemonId(cmd, args, env2);
    expect(id1).toBe(id2);
  });

  it('normalizeCommand keeps bare executables unchanged and absolutizes path-like inputs', () => {
    // Bare executable should remain as-is
    const bare = 'node';
    const outBare = normalizeCommand(bare, ['server.js']);
    expect(outBare.command).toBe('node');
    expect(outBare.args).toEqual(['server.js']);

    // Path-like command should be resolved to an absolute path
    const pathLike = './server.js';
    const outPath = normalizeCommand(pathLike, []);
    expect(path.isAbsolute(outPath.command)).toBe(true);
    expect(outPath.command.endsWith('/server.js')).toBe(true);
  });
});
