// The Grok engine: one xAI chat-completions tool loop per turn.
// Auth is a Grok device-code login (SuperGrok / X) or XAI_API_KEY. See ./auth.ts.
// Team tools are the same AgentCraft tools Claude and Codex get. File tools go through
// the same permission gate (policy + in-game prompt) before anything is read or written.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { GrokConfig } from '../../config.js';
import type { Foreman } from '../../foreman.js';
import { truncate } from '../../util/text.js';
import type { AuthCheck, Engine, Role, TurnSpec, TurnStats } from '../engine.js';
import type { AgentTool } from '../tools.js';
import { GROK_API_BASE, resolveBearer } from './auth.js';
import { applyEdit, grepTree, readText, resolveInside, runCommand, writeText } from './files.js';

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

const FILE_TOOLS: Record<Role, Array<{ name: string; description: string; shape: z.ZodRawShape }>> = {
  lead: [
    { name: 'Read', description: 'Read a text file inside the checkout.', shape: { file_path: z.string() } },
    { name: 'Grep', description: 'Search files. pattern is a JavaScript regular expression.', shape: { pattern: z.string(), path: z.string().optional() } },
    { name: 'Bash', description: 'Run a shell command. Reads are fine; anything else waits for the user.', shape: { command: z.string() } },
  ],
  worker: [
    { name: 'Read', description: 'Read a text file in the worktree.', shape: { file_path: z.string() } },
    { name: 'Grep', description: 'Search the worktree. pattern is a JavaScript regular expression.', shape: { pattern: z.string(), path: z.string().optional() } },
    { name: 'Edit', description: 'Replace one unique old_string with new_string in a file.', shape: { file_path: z.string(), old_string: z.string(), new_string: z.string() } },
    { name: 'Write', description: 'Create or overwrite a file in the worktree.', shape: { file_path: z.string(), content: z.string() } },
    { name: 'Bash', description: 'Run a shell command in the worktree. Policy and the user may deny it.', shape: { command: z.string() } },
  ],
};

function parameters(shape: z.ZodRawShape): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(shape)) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

function sessionFile(home: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('bad session id');
  return path.join(home, 'grok-sessions', `${id}.json`);
}

export class GrokEngine implements Engine {
  readonly id = 'grok' as const;
  readonly label = 'Grok';

  constructor(
    private fm: Foreman,
    private cfg: GrokConfig,
  ) {}

  model(role: Role): string {
    return role === 'lead' ? this.cfg.leadModel : this.cfg.workerModel;
  }

  authFailedMessage(detail: string): string {
    return `Grok authentication failed (${detail}). Run \`npm run grok-login\` in foreman/, or set XAI_API_KEY.`;
  }

  async checkAuth(): Promise<AuthCheck> {
    const auth = await resolveBearer(this.cfg.home, this.cfg.useGrokLogin);
    if ('error' in auth) return { ok: false, message: auth.error };
    return { ok: true, account: auth.account ? `${auth.source} · ${auth.account}` : auth.source };
  }

  async runTurn(spec: TurnSpec): Promise<TurnStats> {
    const errors: string[] = [];
    const auth = await resolveBearer(this.cfg.home, this.cfg.useGrokLogin, spec.env as NodeJS.ProcessEnv);
    if ('error' in auth) return { isError: true, authFailed: auth.error, errors: [auth.error], subtype: 'auth' };

    const model = this.model(spec.role);
    spec.onModel?.(model);
    const sessionId = spec.resume && /^[a-zA-Z0-9_-]+$/.test(spec.resume) ? spec.resume : `grok-${spec.agentId}-${Date.now().toString(36)}`;
    spec.onSession(sessionId);

    let messages = this.loadSession(sessionId);
    if (!messages.length) {
      messages = [
        {
          role: 'system',
          content:
            spec.instructions +
            '\n\n# Working in AgentCraft (Grok)\n' +
            'Use the team tools (send_message, ask_user, update_task, and the rest) for anything the team or the user should see. ' +
            'Plain text only lands on your monitor. Do not push, do not touch the network unless a command was allowed, and do not spawn sub-agents.',
        },
        { role: 'user', content: spec.prompt },
      ];
    } else {
      messages.push({ role: 'user', content: spec.prompt });
    }

    const tools = [
      ...FILE_TOOLS[spec.role].map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: parameters(t.shape) } })),
      ...spec.tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: parameters(t.shape) } })),
    ];
    const team = new Map(spec.tools.map((t) => [t.name, t]));
    const maxTurns = spec.role === 'lead' ? this.cfg.maxTurnsLead : this.cfg.maxTurnsWorker;
    let tokens = 0;
    let resultText = '';
    let numTurns = 0;

    try {
      for (; numTurns < maxTurns; numTurns++) {
        if (spec.abort.signal.aborted) break;
        const res = await this.complete(auth.token, model, messages, tools, spec.abort.signal);
        if (res.status === 401) {
          const detail = 'unauthorized';
          return { isError: true, authFailed: detail, errors: [detail], sessionId, tokens, subtype: 'auth' };
        }
        if (!res.ok) {
          errors.push(`Grok API ${res.status}`);
          return { isError: true, errors, sessionId, tokens, resultText, subtype: 'error' };
        }
        tokens += res.tokens;
        const call = res.toolCalls;
        messages.push({ role: 'assistant', content: res.text || null, ...(call.length ? { tool_calls: call } : {}) });
        if (res.text) {
          resultText = res.text;
          this.fm.agentLog(spec.agentId, 'text', truncate(res.text, 400));
        }
        if (!call.length) break;
        for (const tool of call) {
          if (spec.abort.signal.aborted) break;
          const args = parseArgs(tool.function.arguments);
          this.fm.agentLog(spec.agentId, 'tool', truncate(`${tool.function.name} ${JSON.stringify(args)}`, 240));
          const text = await this.dispatch(spec, team, tool.function.name, args);
          messages.push({ role: 'tool', tool_call_id: tool.id, content: truncate(text, 12_000) });
        }
      }
      if (numTurns >= maxTurns && !resultText) errors.push('turn limit reached');
    } catch (e) {
      if (!spec.abort.signal.aborted) errors.push((e as Error).message);
    }

    this.saveSession(sessionId, messages);
    const aborted = spec.abort.signal.aborted;
    return {
      sessionId,
      resultText,
      isError: aborted || errors.length > 0,
      errors,
      tokens,
      numTurns,
      subtype: aborted ? 'abort' : errors.length ? 'error' : 'success',
    };
  }

  private async dispatch(spec: TurnSpec, team: Map<string, AgentTool>, name: string, args: Record<string, unknown>): Promise<string> {
    const teamTool = team.get(name);
    if (teamTool) {
      try {
        const result = await teamTool.handler(args);
        return result.content.map((c) => c.text).join('\n');
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    }
    const gateName = name;
    const gateInput = name === 'Bash' ? { command: String(args.command ?? '') } : { file_path: String(args.file_path ?? args.path ?? '') };
    const allowed = await spec.permission(gateName, { ...args, ...gateInput }, spec.abort.signal, name);
    if (!allowed.allow) return `Denied: ${allowed.message}`;
    try {
      return await this.fileTool(spec, name, args);
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  }

  private async fileTool(spec: TurnSpec, name: string, args: Record<string, unknown>): Promise<string> {
    const roots = spec.writableRoots ?? [];
    if (name === 'Read') return readText(resolveInside(spec.cwd, roots, String(args.file_path ?? '')));
    if (name === 'Grep') return grepTree(spec.cwd, String(args.pattern ?? ''), args.path ? String(args.path) : '.');
    if (name === 'Write') {
      const abs = resolveInside(spec.cwd, roots, String(args.file_path ?? ''));
      writeText(abs, String(args.content ?? ''));
      return `wrote ${args.file_path}`;
    }
    if (name === 'Edit') {
      const abs = resolveInside(spec.cwd, roots, String(args.file_path ?? ''));
      const next = applyEdit(readText(abs), String(args.old_string ?? ''), String(args.new_string ?? ''));
      writeText(abs, next);
      return `edited ${args.file_path}`;
    }
    if (name === 'Bash') {
      const command = String(args.command ?? '');
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const [k, v] of Object.entries(spec.env)) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
      const ran = await runCommand(spec.cwd, command, env, spec.abort.signal, spec.onProcess);
      return `exit ${ran.code ?? '?'}\n${ran.output}`;
    }
    return `unknown tool ${name}`;
  }

  private loadSession(id: string): ChatMessage[] {
    try {
      const raw = JSON.parse(fs.readFileSync(sessionFile(this.cfg.home, id), 'utf8')) as ChatMessage[];
      return Array.isArray(raw) ? raw.slice(-40) : [];
    } catch {
      return [];
    }
  }

  private saveSession(id: string, messages: ChatMessage[]): void {
    const file = sessionFile(this.cfg.home, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(messages.slice(-40)));
  }

  private async complete(token: string, model: string, messages: ChatMessage[], tools: unknown[], signal: AbortSignal): Promise<{ ok: boolean; status: number; text: string; toolCalls: ToolCall[]; tokens: number }> {
    const res = await fetch(`${GROK_API_BASE}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, temperature: 0.2, max_tokens: 2048 }),
    });
    if (!res.ok) return { ok: false, status: res.status, text: '', toolCalls: [], tokens: 0 };
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
      usage?: { total_tokens?: number };
    };
    const message = body.choices?.[0]?.message;
    return {
      ok: true,
      status: res.status,
      text: message?.content ?? '',
      toolCalls: message?.tool_calls ?? [],
      tokens: body.usage?.total_tokens ?? 0,
    };
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
