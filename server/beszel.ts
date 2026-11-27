import { decryptSecret, encryptSecret } from './crypto.ts';
import { getSetting, setSetting } from './db.ts';

export interface BeszelConfig {
  enabled: boolean;
  url: string;
  email: string;
  hasPassword: boolean;
}

export interface BeszelSystemSummary {
  id: string;
  name: string;
  host: string;
  status: string;
  cpu: number;
  memPercent: number;
  diskPercent: number;
  uptime: number;
  updated: string;
}

export interface BeszelStatPoint {
  created: string;
  cpu: number;
  memPercent: number;
  diskPercent: number;
  netSentMb: number;
  netRecvMb: number;
}

export function validateBeszelUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('آدرس سرور Beszel معتبر نیست.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('پروتکل آدرس Beszel باید http یا https باشد.');
  }
  // Block cloud metadata & link-local endpoints (IPv4 and IPv6)
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'metadata.google.internal' ||
    host === 'metadata.goog' ||
    host === 'metadata.azure.com' ||
    host === '169.254.169.254' ||
    host.startsWith('169.254.') ||
    host.startsWith('::ffff:169.254.') ||
    host.startsWith('fe80:') ||
    host === 'fd00:ec2::254'
  ) {
    throw new Error('دسترسی به آدرس متادیتا یا لینک-لوکال مجاز نیست.');
  }
  return parsed.toString().replace(/\/+$/, '');
}

export function getBeszelConfigPublic(): BeszelConfig {
  const url = getSetting('beszel_url') ?? '';
  const email = getSetting('beszel_email') ?? '';
  const encPass = getSetting('beszel_password_enc') ?? '';
  const enabled = getSetting('beszel_enabled') === '1';
  return {
    enabled,
    url,
    email,
    hasPassword: Boolean(encPass),
  };
}

export function saveBeszelConfig(input: {
  enabled: boolean;
  url: string;
  email: string;
  password?: string;
}): BeszelConfig {
  const cleanUrl = input.url.trim() ? validateBeszelUrl(input.url) : '';
  setSetting('beszel_enabled', input.enabled ? '1' : '0');
  setSetting('beszel_url', cleanUrl);
  setSetting('beszel_email', input.email.trim());
  if (input.password && input.password.trim().length > 0) {
    setSetting('beszel_password_enc', encryptSecret(input.password));
  }
  return getBeszelConfigPublic();
}

export function getBeszelConfigForBackup(): {
  enabled: boolean;
  url: string;
  email: string;
  password: string;
} {
  return {
    enabled: getSetting('beszel_enabled') === '1',
    url: getSetting('beszel_url') ?? '',
    email: getSetting('beszel_email') ?? '',
    password: decryptSecret(getSetting('beszel_password_enc')),
  };
}

export function restoreBeszelConfigFromBackup(input: {
  enabled?: boolean;
  url?: string;
  email?: string;
  password?: string;
}): void {
  const rawUrl = typeof input.url === 'string' ? input.url.trim() : '';
  const cleanUrl = rawUrl ? validateBeszelUrl(rawUrl) : '';
  setSetting('beszel_enabled', input.enabled ? '1' : '0');
  setSetting('beszel_url', cleanUrl);
  setSetting('beszel_email', typeof input.email === 'string' ? input.email.trim() : '');
  if (typeof input.password === 'string' && input.password.length > 0) {
    setSetting('beszel_password_enc', encryptSecret(input.password));
  }
}

async function authenticateBeszel(baseUrl: string, email: string, password: string): Promise<string> {
  const endpoints = [
    `${baseUrl}/api/collections/users/auth-with-password`,
    `${baseUrl}/api/collections/_superusers/auth-with-password`,
  ];

  for (const endpoint of endpoints) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: email, password }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = (await res.json()) as { token?: string };
      if (data.token) {
        return data.token;
      }
    }
  }
  throw new Error('احراز هویت با سرور Beszel ناموفق بود. ایمیل یا رمز عبور را بررسی کنید.');
}

export async function fetchBeszelTelemetry(): Promise<{
  connected: boolean;
  error?: string;
  systems: BeszelSystemSummary[];
  history: BeszelStatPoint[];
}> {
  const enabled = getSetting('beszel_enabled') === '1';
  const url = getSetting('beszel_url') ?? '';
  const email = getSetting('beszel_email') ?? '';
  const password = decryptSecret(getSetting('beszel_password_enc'));

  if (!enabled || !url || !email || !password) {
    return { connected: false, systems: [], history: [] };
  }

  try {
    const cleanUrl = validateBeszelUrl(url);
    const token = await authenticateBeszel(cleanUrl, email, password);
    const headers = { Authorization: token };

    const sysRes = await fetch(`${cleanUrl}/api/collections/systems/records?perPage=20`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!sysRes.ok) {
      throw new Error(`خطای دریافت سیستم‌ها از Beszel (${sysRes.status})`);
    }
    const sysData = (await sysRes.json()) as {
      items?: Array<{
        id: string;
        name: string;
        host: string;
        status: string;
        updated: string;
        info?: { cpu?: number; mp?: number; dp?: number; u?: number };
      }>;
    };

    const systems: BeszelSystemSummary[] = (sysData.items ?? []).map((s) => ({
      id: s.id,
      name: s.name || s.host,
      host: s.host,
      status: s.status || 'up',
      cpu: Number(s.info?.cpu ?? 0),
      memPercent: Number(s.info?.mp ?? 0),
      diskPercent: Number(s.info?.dp ?? 0),
      uptime: Number(s.info?.u ?? 0),
      updated: s.updated,
    }));

    let history: BeszelStatPoint[] = [];
    if (systems.length > 0) {
      const primaryId = encodeURIComponent(systems[0].id);
      const statsRes = await fetch(
        `${cleanUrl}/api/collections/system_stats/records?filter=(system='${primaryId}')&sort=-created&perPage=30`,
        { headers, signal: AbortSignal.timeout(8000) },
      );
      if (statsRes.ok) {
        const statsData = (await statsRes.json()) as {
          items?: Array<{
            created: string;
            stats?: { cpu?: number; mp?: number; dp?: number; ns?: number; nr?: number };
          }>;
        };
        history = (statsData.items ?? [])
          .map((item) => ({
            created: item.created,
            cpu: Number(item.stats?.cpu ?? 0),
            memPercent: Number(item.stats?.mp ?? 0),
            diskPercent: Number(item.stats?.dp ?? 0),
            netSentMb: Number(item.stats?.ns ?? 0),
            netRecvMb: Number(item.stats?.nr ?? 0),
          }))
          .reverse();
      }
    }

    return { connected: true, systems, history };
  } catch (err) {
    return {
      connected: false,
      error: err instanceof Error ? err.message : 'خطا در ارتباط با Beszel',
      systems: [],
      history: [],
    };
  }
}
