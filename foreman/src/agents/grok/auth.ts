// Grok authentication: xAI device-code OAuth (the same flow as `grok login --device-auth`)
// or an XAI_API_KEY. The client id is the public Grok CLI id — not a secret.
// Tokens are written only to <home>/grok-oauth.json (mode 0600) and never logged.
import fs from 'node:fs';
import path from 'node:path';

/** Public client id shipped in the Grok CLI. Device flow, no client secret. */
export const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const GROK_SCOPE = 'openid profile email offline_access api:access';
export const GROK_DEVICE_URL = 'https://auth.x.ai/oauth2/device/code';
export const GROK_TOKEN_URL = 'https://auth.x.ai/oauth2/token';
export const GROK_USERINFO_URL = 'https://auth.x.ai/oauth2/userinfo';
export const GROK_API_BASE = 'https://api.x.ai/v1';

export interface GrokTokens {
  access_token: string;
  refresh_token?: string;
  /** epoch ms */
  expires_at: number;
  account?: string;
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

const SKEW_MS = 60_000;

export function tokenPath(home: string): string {
  return path.join(home, 'grok-oauth.json');
}

export function loadTokens(home: string): GrokTokens | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(tokenPath(home), 'utf8')) as Partial<GrokTokens>;
    if (!raw.access_token || typeof raw.expires_at !== 'number') return undefined;
    return {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token,
      expires_at: raw.expires_at,
      account: raw.account,
    };
  } catch {
    return undefined;
  }
}

export function saveTokens(home: string, tokens: GrokTokens): void {
  fs.mkdirSync(home, { recursive: true });
  const file = tokenPath(home);
  fs.writeFileSync(file, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
}

async function postForm(url: string, body: Record<string, string>): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

export async function requestDeviceCode(): Promise<DeviceCode> {
  const { ok, status, json } = await postForm(GROK_DEVICE_URL, { client_id: GROK_CLIENT_ID, scope: GROK_SCOPE });
  if (!ok || typeof json.device_code !== 'string' || typeof json.user_code !== 'string') {
    throw new Error(`Grok device authorization failed (${status})`);
  }
  const verification = typeof json.verification_uri === 'string' ? json.verification_uri : 'https://accounts.x.ai/oauth2/device';
  const complete = typeof json.verification_uri_complete === 'string' ? json.verification_uri_complete : `${verification}?user_code=${json.user_code}`;
  return {
    device_code: json.device_code,
    user_code: json.user_code,
    verification_uri: verification,
    verification_uri_complete: complete,
    expires_in: typeof json.expires_in === 'number' ? json.expires_in : 1800,
    interval: typeof json.interval === 'number' ? Math.max(1, json.interval) : 5,
  };
}

export type PollResult =
  | { status: 'pending'; interval: number }
  | { status: 'slow_down'; interval: number }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'ready'; tokens: GrokTokens };

/** One poll of the device grant. Does not loop. */
export async function pollDeviceOnce(device: DeviceCode, interval: number): Promise<PollResult> {
  const { ok, json } = await postForm(GROK_TOKEN_URL, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: device.device_code,
    client_id: GROK_CLIENT_ID,
  });
  const err = typeof json.error === 'string' ? json.error : '';
  if (err === 'authorization_pending') return { status: 'pending', interval };
  if (err === 'slow_down') return { status: 'slow_down', interval: interval + 5 };
  if (err === 'access_denied') return { status: 'denied' };
  if (err === 'expired_token') return { status: 'expired' };
  if (!ok || typeof json.access_token !== 'string') {
    throw new Error(`Grok token request failed${err ? `: ${err}` : ''}`);
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  return {
    status: 'ready',
    tokens: {
      access_token: json.access_token,
      refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
      expires_at: Date.now() + expiresIn * 1000,
    },
  };
}

export async function refreshTokens(tokens: GrokTokens): Promise<GrokTokens> {
  if (!tokens.refresh_token) throw new Error('Grok login has no refresh token. Run npm run grok-login again.');
  const { ok, json } = await postForm(GROK_TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: GROK_CLIENT_ID,
  });
  if (!ok || typeof json.access_token !== 'string') throw new Error('Grok token refresh failed. Run npm run grok-login again.');
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  return {
    access_token: json.access_token,
    refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : tokens.refresh_token,
    expires_at: Date.now() + expiresIn * 1000,
    account: tokens.account,
  };
}

export async function fetchAccount(accessToken: string): Promise<string> {
  const res = await fetch(GROK_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
  if (!res.ok) return 'Grok';
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const email = typeof body.email === 'string' ? body.email : '';
  const name = typeof body.name === 'string' ? body.name : typeof body.preferred_username === 'string' ? body.preferred_username : '';
  return email || name || 'Grok';
}

export function tokenFresh(tokens: GrokTokens, now = Date.now()): boolean {
  return tokens.expires_at - SKEW_MS > now;
}

/**
 * Bearer for API calls. OAuth login wins when useGrokLogin is set and a token file exists
 * (refreshed when it is close to expiry). Otherwise XAI_API_KEY.
 */
export async function resolveBearer(home: string, useGrokLogin: boolean, env: NodeJS.ProcessEnv = process.env): Promise<{ token: string; source: string; account?: string } | { error: string }> {
  if (useGrokLogin) {
    let tokens = loadTokens(home);
    if (tokens && !tokenFresh(tokens)) {
      try {
        tokens = await refreshTokens(tokens);
        if (!tokens.account) tokens.account = await fetchAccount(tokens.access_token).catch(() => tokens!.account);
        saveTokens(home, tokens);
      } catch (e) {
        tokens = undefined;
        return { error: (e as Error).message };
      }
    }
    if (tokens) {
      return { token: tokens.access_token, source: 'Grok login', account: tokens.account };
    }
  }
  const key = env.XAI_API_KEY?.trim();
  if (key) return { token: key, source: 'API key' };
  return {
    error: useGrokLogin
      ? 'Not signed in to Grok. From foreman/, run `npm run grok-login` (device code at accounts.x.ai), then restart. Or set XAI_API_KEY and pass --no-use-grok-login.'
      : 'No XAI_API_KEY. Set one from console.x.ai, or drop --no-use-grok-login and run `npm run grok-login`.',
  };
}

/** Interactive device login. Calls onCode once, then polls until the browser approves. */
export async function loginDevice(home: string, onCode: (userCode: string, url: string) => void): Promise<GrokTokens> {
  const device = await requestDeviceCode();
  onCode(device.user_code, device.verification_uri_complete);
  const deadline = Date.now() + device.expires_in * 1000;
  let interval = device.interval;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const polled = await pollDeviceOnce(device, interval);
    if (polled.status === 'pending') continue;
    if (polled.status === 'slow_down') {
      interval = polled.interval;
      continue;
    }
    if (polled.status === 'denied') throw new Error('Grok sign-in was denied.');
    if (polled.status === 'expired') throw new Error('Grok sign-in code expired. Run npm run grok-login again.');
    const account = await fetchAccount(polled.tokens.access_token).catch(() => 'Grok');
    const saved = { ...polled.tokens, account };
    saveTokens(home, saved);
    return saved;
  }
  throw new Error('Grok sign-in timed out.');
}
