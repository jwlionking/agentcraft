// Worktree file tools for the Grok engine. Paths must stay inside the turn's cwd or an
// extra writable root (the worktree git dir). The policy gate still runs before any of this.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function resolveInside(cwd: string, extraRoots: string[], requestPath: string): string {
  const abs = path.resolve(cwd, requestPath);
  const roots = [cwd, ...extraRoots].map((r) => path.resolve(r));
  const ok = roots.some((root) => abs === root || abs.startsWith(root + path.sep));
  if (!ok) throw new Error(`path is outside the worktree: ${requestPath}`);
  return abs;
}

export function readText(abs: string, max = 100_000): string {
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error('not a file');
  if (stat.size > max) return fs.readFileSync(abs, 'utf8').slice(0, max) + `\n…[truncated, ${stat.size} bytes]`;
  return fs.readFileSync(abs, 'utf8');
}

export function writeText(abs: string, content: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Replace the first exact occurrence. Throws if it is missing or ambiguous when all=false. */
export function applyEdit(before: string, oldText: string, newText: string): string {
  if (!oldText) throw new Error('old_string is empty');
  const at = before.indexOf(oldText);
  if (at < 0) throw new Error('old_string was not found');
  if (before.indexOf(oldText, at + oldText.length) >= 0) throw new Error('old_string is not unique; include more context');
  return before.slice(0, at) + newText + before.slice(at + oldText.length);
}

export function grepTree(cwd: string, pattern: string, sub = '.', limit = 40): string {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    throw new Error(`bad pattern: ${pattern}`);
  }
  const root = resolveInside(cwd, [], sub);
  const hits: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (hits.length >= limit || depth > 6) return;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (hits.length >= limit) return;
      if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
      const abs = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs, depth + 1);
      else if (st.isFile() && st.size < 500_000) {
        let text = '';
        try {
          text = fs.readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < limit; i++) {
          if (re.test(lines[i]!)) hits.push(`${path.relative(cwd, abs)}:${i + 1}: ${lines[i]!.slice(0, 200)}`);
        }
      }
    }
  };
  walk(root, 0);
  return hits.length ? hits.join('\n') : 'no matches';
}

export function runCommand(
  cwd: string,
  command: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  onProcess?: (child: ReturnType<typeof spawn>) => void,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true });
    onProcess?.(child);
    let output = '';
    const take = (chunk: Buffer) => {
      if (output.length < 12_000) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const timer = setTimeout(() => child.kill('SIGTERM'), 120_000);
    const onAbort = () => child.kill('SIGTERM');
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ code: null, output: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ code, output: output.slice(0, 12_000) });
    });
  });
}
