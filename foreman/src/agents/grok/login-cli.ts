// `npm run grok-login` — device-code sign-in against accounts.x.ai.
// Prints a URL and a short code. Approve them in a browser. Tokens land in
// <AGENTCRAFT_HOME>/grok-oauth.json (default ~/.agentcraft), mode 0600.
import os from 'node:os';
import path from 'node:path';
import { loginDevice } from './auth.js';

const home = path.resolve(process.env.AGENTCRAFT_HOME ?? path.join(os.homedir(), '.agentcraft'));

loginDevice(home, (code, url) => {
  process.stdout.write(`\nSign in with Grok\n\n  Open: ${url}\n  Code: ${code}\n\nWaiting for approval…\n`);
})
  .then((tokens) => {
    process.stdout.write(`Signed in${tokens.account ? ` as ${tokens.account}` : ''}.\n`);
  })
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
