import { describe, expect, it } from 'vitest';
import { applyEdit, resolveInside } from '../src/agents/grok/files.js';
import { tokenFresh } from '../src/agents/grok/auth.js';
import { loadConfig } from '../src/config.js';
import { rmrf, tempDir } from './helpers.js';

describe('grok config', () => {
  it('defaults an all-Grok team to device login and grok-4.5', () => {
    const home = tempDir();
    try {
      const cfg = loadConfig(['--home', home, '--backend', 'grok'], {});
      expect(cfg.backend).toBe('grok');
      expect(cfg.engines.lead).toBe('grok');
      expect(cfg.engines.worker).toBe('grok');
      expect(cfg.grok.useGrokLogin).toBe(true);
      expect(cfg.grok.leadModel).toBe('grok-4.5');
      expect(cfg.grok.workerModel).toBe('grok-4.5');
      expect(cfg.grok.home).toBe(home);
    } finally {
      rmrf(home);
    }
  });

  it('can mix a Grok worker under a Claude lead and turn login off', () => {
    const home = tempDir();
    try {
      const cfg = loadConfig(['--home', home, '--backend', 'claude', '--worker-engine', 'grok', '--no-use-grok-login', '--grok-model', 'grok-4-fast'], {});
      expect(cfg.engines.lead).toBe('claude');
      expect(cfg.engines.worker).toBe('grok');
      expect(cfg.grok.useGrokLogin).toBe(false);
      expect(cfg.grok.workerModel).toBe('grok-4-fast');
    } finally {
      rmrf(home);
    }
  });
});

describe('grok files and tokens', () => {
  it('refuses paths that escape the worktree', () => {
    expect(() => resolveInside('/repo', [], '../etc/passwd')).toThrow(/outside/);
    expect(resolveInside('/repo', ['/repo/.git'], 'src/a.ts')).toBe('/repo/src/a.ts');
  });

  it('replaces one unique span', () => {
    expect(applyEdit('alpha beta alpha', 'beta', 'gamma')).toBe('alpha gamma alpha');
    expect(() => applyEdit('alpha alpha', 'alpha', 'x')).toThrow(/not unique/);
  });

  it('treats a token as stale inside the skew window', () => {
    expect(tokenFresh({ access_token: 'a', expires_at: Date.now() + 10_000 })).toBe(false);
    expect(tokenFresh({ access_token: 'a', expires_at: Date.now() + 120_000 })).toBe(true);
  });
});
