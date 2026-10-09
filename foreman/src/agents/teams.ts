// Build the agent team for `--backend claude|codex|grok` with the engines the config picks per role
// and per agent (e.g. a Grok lead with Codex workers).
import type { Config, EngineName } from '../config.js';
import type { Foreman } from '../foreman.js';
import { ClaudeEngine } from './claude/engine.js';
import { CodexEngine } from './codex/engine.js';
import type { Engine } from './engine.js';
import { GrokEngine } from './grok/engine.js';
import { TeamBackend } from './team.js';

export function createTeam(fm: Foreman, cfg: Config): TeamBackend {
  let claude: ClaudeEngine | undefined;
  let codex: CodexEngine | undefined;
  let grok: GrokEngine | undefined;
  const engine = (n: EngineName): Engine => {
    if (n === 'codex') return (codex ??= new CodexEngine(fm, cfg.codex));
    if (n === 'grok') return (grok ??= new GrokEngine(fm, cfg.grok));
    return (claude ??= new ClaudeEngine(fm, cfg.claude));
  };
  const byAgent = Object.fromEntries(Object.entries(cfg.engines.byAgent).map(([agent, n]) => [agent, engine(n)]));
  const name = cfg.backend === 'codex' || cfg.backend === 'grok' ? cfg.backend : 'claude';
  return new TeamBackend(fm, cfg.claude, {
    name,
    engines: { lead: engine(cfg.engines.lead), worker: engine(cfg.engines.worker), byAgent },
  });
}