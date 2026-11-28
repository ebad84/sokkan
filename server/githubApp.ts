import crypto from 'node:crypto';
import {
  decryptSecret,
  encryptSecret,
  generateRandomHex,
  verifyGitHubSignature,
} from './crypto.ts';
import { db, type GitHubAppRow } from './db.ts';

export interface GitHubAppInstallationSummary {
  id: number;
  accountLogin: string;
  accountType: string;
  accountAvatarUrl: string;
  repositorySelection: 'all' | 'selected';
  htmlUrl: string;
}

export interface GitHubAppPublicStatus {
  connected: boolean;
  installed: boolean;
  appId: number | null;
  slug: string;
  name: string;
  ownerLogin: string;
  htmlUrl: string;
  installUrl: string;
  installations: GitHubAppInstallationSummary[];
  updatedAt: string | null;
}

export interface GitHubAppRepoItem {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  isPrivate: boolean;
  description: string;
  updatedAt: string;
  installationId: number;
}

export interface GitHubAppBackupRecord {
  appId: number;
  slug: string;
  name: string;
  ownerLogin: string;
  htmlUrl: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  privateKeyPem: string;
  installations: GitHubAppInstallationSummary[];
}

interface PendingManifestState {
  userId: string;
  baseUrl: string;
  createdAt: number;
}

const pendingManifestStates = new Map<string, PendingManifestState>();
const MANIFEST_STATE_TTL_MS = 15 * 60 * 1000;

interface CachedInstallationToken {
  token: string;
  expiresAtMs: number;
}

const installationTokenCache = new Map<number, CachedInstallationToken>();

const PRIMARY_APP_ROW_ID = 'ghapp_primary';
const GITHUB_API_HEADERS_BASE = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'Sokkan-PaaS',
  'X-GitHub-Api-Version': '2022-11-28',
};

function pruneExpiredStates(): void {
  const cutoff = Date.now() - MANIFEST_STATE_TTL_MS;
  for (const [k, v] of pendingManifestStates.entries()) {
    if (v.createdAt < cutoff) {
      pendingManifestStates.delete(k);
    }
  }
}

export function sanitizeGitHubAppSlug(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9-]+$/.test(s) ? s : '';
}

function sanitizeGitHubHtmlUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' && parsed.hostname === 'github.com') {
      return parsed.toString();
    }
  } catch {
    return '';
  }
  return '';
}

function sanitizeAvatarUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'avatars.githubusercontent.com' || parsed.hostname === 'github.com')
    ) {
      return parsed.toString();
    }
  } catch {
    return '';
  }
  return '';
}

export function normalizePanelBaseUrl(clientOrigin?: string): string {
  const candidates = [process.env.APP_URL?.trim(), clientOrigin?.trim()].filter(
    (v): v is string => Boolean(v),
  );
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
      if (
        parsed.protocol === 'http:' &&
        parsed.hostname !== 'localhost' &&
        parsed.hostname !== '127.0.0.1'
      ) {
        // Still allow explicit http on private/VPS IP if user accesses panel via http,
        // but prefer https when available.
      }
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      continue;
    }
  }
  throw new Error('آدرس پایه پنل (Base URL) نامعتبر است.');
}

function parseInstallationsJson(raw: string): GitHubAppInstallationSummary[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((item): GitHubAppInstallationSummary => ({
        id: Number(item.id) || 0,
        accountLogin: String(item.accountLogin || ''),
        accountType: String(item.accountType || 'User'),
        accountAvatarUrl: sanitizeAvatarUrl(item.accountAvatarUrl),
        repositorySelection: item.repositorySelection === 'selected' ? 'selected' : 'all',
        htmlUrl: sanitizeGitHubHtmlUrl(item.htmlUrl),
      }))
      .filter((item) => item.id > 0 && Boolean(item.accountLogin));
  } catch {
    return [];
  }
}

export function getStoredGitHubApp(): GitHubAppRow | null {
  const row = db
    .prepare('SELECT * FROM github_apps WHERE id = ?')
    .get(PRIMARY_APP_ROW_ID) as GitHubAppRow | undefined;
  return row ?? null;
}

export function getGitHubAppPublicStatus(): GitHubAppPublicStatus {
  const row = getStoredGitHubApp();
  if (!row) {
    return {
      connected: false,
      installed: false,
      appId: null,
      slug: '',
      name: '',
      ownerLogin: '',
      htmlUrl: '',
      installUrl: '',
      installations: [],
      updatedAt: null,
    };
  }
  const installations = parseInstallationsJson(row.installations_json);
  const safeSlug = sanitizeGitHubAppSlug(row.slug);
  return {
    connected: true,
    installed: installations.length > 0,
    appId: row.app_id,
    slug: safeSlug,
    name: row.name,
    ownerLogin: row.owner_login,
    htmlUrl: sanitizeGitHubHtmlUrl(row.html_url) || (safeSlug ? `https://github.com/apps/${safeSlug}` : ''),
    installUrl: safeSlug ? `https://github.com/apps/${safeSlug}/installations/new` : '',
    installations,
    updatedAt: row.updated_at,
  };
}

export function createManifestRequest(opts: {
  userId: string;
  clientOrigin?: string;
  appName?: string;
  organization?: string;
}): {
  state: string;
  actionUrl: string;
  manifestJson: string;
  callbackUrl: string;
  setupUrl: string;
  webhookUrl: string;
  isHttps: boolean;
} {
  pruneExpiredStates();
  const baseUrl = normalizePanelBaseUrl(opts.clientOrigin);
  const isHttps = baseUrl.startsWith('https://');
  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(baseUrl);

  const rawOrg = (opts.organization || '').trim();
  if (rawOrg && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(rawOrg)) {
    throw new Error('نام سازمان گیتهاب (Organization) نامعتبر است.');
  }

  let appName = (opts.appName || '').trim().replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 34);
  if (!appName) {
    appName = `sokkan-${generateRandomHex(3)}`;
  }

  const state = generateRandomHex(24);
  pendingManifestStates.set(state, {
    userId: opts.userId,
    baseUrl,
    createdAt: Date.now(),
  });

  const callbackUrl = `${baseUrl}/api/github/app/callback`;
  const setupUrl = `${baseUrl}/api/github/app/installed`;
  const webhookUrl = `${baseUrl}/api/webhooks/github-app`;

  const manifest = {
    name: appName,
    url: baseUrl,
    hook_attributes: {
      url: webhookUrl,
      active: !isLocalhost,
    },
    redirect_url: callbackUrl,
    setup_url: setupUrl,
    callback_urls: [callbackUrl],
    public: false,
    default_permissions: {
      contents: 'read',
      metadata: 'read',
      packages: 'read',
      actions: 'read',
    },
    default_events: ['push', 'workflow_run'],
  };

  const actionUrl = rawOrg
    ? `https://github.com/organizations/${encodeURIComponent(rawOrg)}/settings/apps/new?state=${encodeURIComponent(state)}`
    : `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;

  return {
    state,
    actionUrl,
    manifestJson: JSON.stringify(manifest),
    callbackUrl,
    setupUrl,
    webhookUrl,
    isHttps,
  };
}

export async function completeManifestCallback(
  code: string,
  state: string,
): Promise<{ status: GitHubAppPublicStatus; installUrl: string }> {
  pruneExpiredStates();
  const cleanState = state.trim();
  const cleanCode = code.trim();

  if (!cleanState || !pendingManifestStates.has(cleanState)) {
    throw new Error('نشست امنیتی اتصال گیتهاب منقضی شده یا نامعتبر است. لطفاً دوباره روی دکمه اتصال کلیک کنید.');
  }
  pendingManifestStates.delete(cleanState);

  if (!/^[A-Za-z0-9_-]{8,128}$/.test(cleanCode)) {
    throw new Error('کد تایید برگشتی از گیتهاب نامعتبر است.');
  }

  const res = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(cleanCode)}/conversions`,
    {
      method: 'POST',
      headers: GITHUB_API_HEADERS_BASE,
      signal: AbortSignal.timeout(12000),
    },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      `دریافت اطلاعات GitHub App از گیتهاب ناموفق بود (کد ${res.status})${errText ? `: ${errText.slice(0, 140)}` : ''}`,
    );
  }

  const data = (await res.json()) as {
    id?: number;
    slug?: string;
    name?: string;
    owner?: { login?: string };
    html_url?: string;
    client_id?: string;
    client_secret?: string;
    webhook_secret?: string;
    pem?: string;
  };

  const appId = Number(data.id);
  const slug = sanitizeGitHubAppSlug(data.slug);
  const pem = typeof data.pem === 'string' ? data.pem : '';
  if (!Number.isInteger(appId) || appId <= 0 || !slug || !pem.includes('PRIVATE KEY')) {
    throw new Error('پاسخ دریافتی از گیتهاب ناقص بود.');
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO github_apps (
      id, app_id, slug, name, owner_login, html_url, client_id,
      client_secret_enc, webhook_secret_enc, private_key_enc,
      installations_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      app_id = excluded.app_id,
      slug = excluded.slug,
      name = excluded.name,
      owner_login = excluded.owner_login,
      html_url = excluded.html_url,
      client_id = excluded.client_id,
      client_secret_enc = excluded.client_secret_enc,
      webhook_secret_enc = excluded.webhook_secret_enc,
      private_key_enc = excluded.private_key_enc,
      installations_json = '[]',
      updated_at = excluded.updated_at`,
  ).run(
    PRIMARY_APP_ROW_ID,
    appId,
    slug,
    String(data.name || slug).slice(0, 80),
    String(data.owner?.login || '').slice(0, 80),
    sanitizeGitHubHtmlUrl(data.html_url) || `https://github.com/apps/${slug}`,
    String(data.client_id || ''),
    encryptSecret(String(data.client_secret || '')),
    encryptSecret(String(data.webhook_secret || '')),
    encryptSecret(pem),
    now,
    now,
  );

  installationTokenCache.clear();
  const status = getGitHubAppPublicStatus();
  return {
    status,
    installUrl: `https://github.com/apps/${slug}/installations/new`,
  };
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function signGitHubAppJwt(appId: number, privateKeyPem: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iat: nowSec - 60,
      exp: nowSec + 540,
      iss: String(appId),
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function getAppJwt(): { row: GitHubAppRow; jwt: string } {
  const row = getStoredGitHubApp();
  if (!row) {
    throw new Error('هنوز هیچ GitHub App به سکان متصل نشده است.');
  }
  const pem = decryptSecret(row.private_key_enc);
  if (!pem || !pem.includes('PRIVATE KEY')) {
    throw new Error('کلید خصوصی GitHub App قابل رمزگشایی نیست. لطفاً اتصال گیتهاب را دوباره برقرار کنید.');
  }
  return {
    row,
    jwt: signGitHubAppJwt(row.app_id, pem),
  };
}

function mapRawInstallation(raw: {
  id?: number;
  account?: { login?: string; type?: string; avatar_url?: string };
  repository_selection?: string;
  html_url?: string;
}): GitHubAppInstallationSummary | null {
  const id = Number(raw.id);
  const login = String(raw.account?.login || '').trim();
  if (!Number.isInteger(id) || id <= 0 || !login) return null;
  return {
    id,
    accountLogin: login,
    accountType: String(raw.account?.type || 'User'),
    accountAvatarUrl: sanitizeAvatarUrl(raw.account?.avatar_url),
    repositorySelection: raw.repository_selection === 'selected' ? 'selected' : 'all',
    htmlUrl: sanitizeGitHubHtmlUrl(raw.html_url),
  };
}

export async function syncGitHubAppInstallations(): Promise<GitHubAppPublicStatus> {
  const { row, jwt } = getAppJwt();
  const res = await fetch('https://api.github.com/app/installations?per_page=100', {
    headers: {
      ...GITHUB_API_HEADERS_BASE,
      Authorization: `Bearer ${jwt}`,
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`همگام‌سازی نصب‌های GitHub App ناموفق بود (کد ${res.status}).`);
  }

  const list = (await res.json()) as Array<{
    id?: number;
    account?: { login?: string; type?: string; avatar_url?: string };
    repository_selection?: string;
    html_url?: string;
  }>;

  const installations = Array.isArray(list)
    ? list.map(mapRawInstallation).filter((v): v is GitHubAppInstallationSummary => Boolean(v))
    : [];

  const now = new Date().toISOString();
  db.prepare('UPDATE github_apps SET installations_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(installations),
    now,
    row.id,
  );

  // Drop cached tokens for removed installations
  const activeIds = new Set(installations.map((i) => i.id));
  for (const cachedId of installationTokenCache.keys()) {
    if (!activeIds.has(cachedId)) {
      installationTokenCache.delete(cachedId);
    }
  }

  return getGitHubAppPublicStatus();
}

export async function completeInstallationCallback(
  installationId: number,
): Promise<GitHubAppPublicStatus> {
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new Error('شناسه نصب GitHub App نامعتبر است.');
  }
  const { jwt } = getAppJwt();
  // Verify this installation actually belongs to our stored GitHub App
  const verifyRes = await fetch(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: {
        ...GITHUB_API_HEADERS_BASE,
        Authorization: `Bearer ${jwt}`,
      },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!verifyRes.ok) {
    throw new Error(`شناسه نصب ${installationId} متعلق به این GitHub App تایید نشد.`);
  }
  return syncGitHubAppInstallations();
}

export async function getInstallationAccessToken(installationId: number): Promise<string> {
  const cached = installationTokenCache.get(installationId);
  if (cached && cached.expiresAtMs - Date.now() > 5 * 60 * 1000) {
    return cached.token;
  }

  const { jwt } = getAppJwt();
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        ...GITHUB_API_HEADERS_BASE,
        Authorization: `Bearer ${jwt}`,
      },
      signal: AbortSignal.timeout(10000),
    },
  );

  if (!res.ok) {
    throw new Error(`تولید توکن موقت GitHub App ناموفق بود (کد ${res.status}).`);
  }

  const data = (await res.json()) as { token?: string; expires_at?: string };
  if (!data.token) {
    throw new Error('گیتهاب توکن موقت برنگرداند.');
  }

  const parsedExp = data.expires_at ? Date.parse(data.expires_at) : NaN;
  const expiresAtMs = Number.isFinite(parsedExp) ? parsedExp : Date.now() + 50 * 60 * 1000;
  installationTokenCache.set(installationId, { token: data.token, expiresAtMs });
  return data.token;
}

export async function resolveGitHubTokenForRepo(
  owner: string,
  explicitPat?: string,
  preferredInstallationId?: number,
): Promise<{
  token: string;
  source: 'pat' | 'github_app' | 'none';
  username: string;
  installationId: number;
}> {
  const cleanPat = (explicitPat || '').trim();
  if (cleanPat) {
    return {
      token: cleanPat,
      source: 'pat',
      username: owner,
      installationId: 0,
    };
  }

  const status = getGitHubAppPublicStatus();
  if (!status.connected || status.installations.length === 0) {
    return { token: '', source: 'none', username: owner, installationId: 0 };
  }

  const candidateIds: number[] = [];
  if (preferredInstallationId && preferredInstallationId > 0) {
    if (status.installations.some((i) => i.id === preferredInstallationId)) {
      candidateIds.push(preferredInstallationId);
    }
  }

  const ownerLower = owner.toLowerCase();
  const ownerMatch = status.installations.find(
    (i) => i.accountLogin.toLowerCase() === ownerLower && !candidateIds.includes(i.id),
  );
  if (ownerMatch) {
    candidateIds.push(ownerMatch.id);
  }

  for (const inst of status.installations) {
    if (!candidateIds.includes(inst.id)) {
      candidateIds.push(inst.id);
    }
  }

  for (const instId of candidateIds) {
    try {
      const token = await getInstallationAccessToken(instId);
      return {
        token,
        source: 'github_app',
        username: 'x-access-token',
        installationId: instId,
      };
    } catch {
      continue;
    }
  }

  return { token: '', source: 'none', username: owner, installationId: 0 };
}

export async function listGitHubAppRepositories(): Promise<GitHubAppRepoItem[]> {
  let status = getGitHubAppPublicStatus();
  if (!status.connected) {
    return [];
  }
  if (status.installations.length === 0) {
    try {
      status = await syncGitHubAppInstallations();
    } catch {
      return [];
    }
  }

  const repos: GitHubAppRepoItem[] = [];
  const seenIds = new Set<number>();

  for (const inst of status.installations) {
    try {
      const token = await getInstallationAccessToken(inst.id);
      for (let page = 1; page <= 3; page++) {
        const res = await fetch(
          `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
          {
            headers: {
              ...GITHUB_API_HEADERS_BASE,
              Authorization: `Bearer ${token}`,
            },
            signal: AbortSignal.timeout(10000),
          },
        );
        if (!res.ok) break;
        const data = (await res.json()) as {
          repositories?: Array<{
            id?: number;
            name?: string;
            full_name?: string;
            owner?: { login?: string };
            html_url?: string;
            clone_url?: string;
            default_branch?: string;
            private?: boolean;
            description?: string | null;
            updated_at?: string;
          }>;
        };
        const items = data.repositories ?? [];
        for (const r of items) {
          const rid = Number(r.id);
          if (!rid || seenIds.has(rid)) continue;
          seenIds.add(rid);
          repos.push({
            id: rid,
            name: String(r.name || ''),
            fullName: String(r.full_name || ''),
            owner: String(r.owner?.login || inst.accountLogin),
            htmlUrl: sanitizeGitHubHtmlUrl(r.html_url),
            cloneUrl: String(r.clone_url || `https://github.com/${r.full_name}.git`),
            defaultBranch: String(r.default_branch || 'main'),
            isPrivate: Boolean(r.private),
            description: String(r.description || ''),
            updatedAt: String(r.updated_at || ''),
            installationId: inst.id,
          });
        }
        if (items.length < 100) break;
      }
    } catch {
      continue;
    }
  }

  repos.sort((a, b) => Date.parse(b.updatedAt || '0') - Date.parse(a.updatedAt || '0'));
  return repos;
}

export async function listGitHubRepoBranches(
  owner: string,
  repo: string,
  installationId?: number,
): Promise<string[]> {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('نام مالک یا مخزن نامعتبر است.');
  }
  const resolved = await resolveGitHubTokenForRepo(owner, undefined, installationId);
  const headers: Record<string, string> = { ...GITHUB_API_HEADERS_BASE };
  if (resolved.token) {
    headers.Authorization = `Bearer ${resolved.token}`;
  }
  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=50`,
    {
      headers,
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!res.ok) {
    return [];
  }
  const data = (await res.json()) as Array<{ name?: string }>;
  return Array.isArray(data)
    ? data.map((b) => String(b.name || '')).filter(Boolean)
    : [];
}

export function verifyGitHubAppWebhook(rawBody: Buffer, signatureHeader: string): boolean {
  const row = getStoredGitHubApp();
  if (!row) return false;
  const secret = decryptSecret(row.webhook_secret_enc);
  if (!secret) return false;
  return verifyGitHubSignature(rawBody, signatureHeader, secret);
}

export function disconnectGitHubApp(): void {
  db.prepare('DELETE FROM github_apps WHERE id = ?').run(PRIMARY_APP_ROW_ID);
  installationTokenCache.clear();
}

export function getGitHubAppForBackup(): GitHubAppBackupRecord | null {
  const row = getStoredGitHubApp();
  if (!row) return null;
  return {
    appId: row.app_id,
    slug: row.slug,
    name: row.name,
    ownerLogin: row.owner_login,
    htmlUrl: row.html_url,
    clientId: row.client_id,
    clientSecret: decryptSecret(row.client_secret_enc),
    webhookSecret: decryptSecret(row.webhook_secret_enc),
    privateKeyPem: decryptSecret(row.private_key_enc),
    installations: parseInstallationsJson(row.installations_json),
  };
}

export function restoreGitHubAppFromBackup(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const rec = raw as Record<string, unknown>;
  const appId = Number(rec.appId);
  const slug = sanitizeGitHubAppSlug(rec.slug);
  const pem = typeof rec.privateKeyPem === 'string' ? rec.privateKeyPem : '';
  if (!Number.isInteger(appId) || appId <= 0 || !slug || !pem.includes('PRIVATE KEY')) {
    return false;
  }

  const installations = Array.isArray(rec.installations)
    ? parseInstallationsJson(JSON.stringify(rec.installations))
    : [];
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO github_apps (
      id, app_id, slug, name, owner_login, html_url, client_id,
      client_secret_enc, webhook_secret_enc, private_key_enc,
      installations_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      app_id = excluded.app_id,
      slug = excluded.slug,
      name = excluded.name,
      owner_login = excluded.owner_login,
      html_url = excluded.html_url,
      client_id = excluded.client_id,
      client_secret_enc = excluded.client_secret_enc,
      webhook_secret_enc = excluded.webhook_secret_enc,
      private_key_enc = excluded.private_key_enc,
      installations_json = excluded.installations_json,
      updated_at = excluded.updated_at`,
  ).run(
    PRIMARY_APP_ROW_ID,
    appId,
    slug,
    String(rec.name || slug).slice(0, 80),
    String(rec.ownerLogin || '').slice(0, 80),
    sanitizeGitHubHtmlUrl(rec.htmlUrl) || `https://github.com/apps/${slug}`,
    String(rec.clientId || ''),
    encryptSecret(String(rec.clientSecret || '')),
    encryptSecret(String(rec.webhookSecret || '')),
    encryptSecret(pem),
    JSON.stringify(installations),
    now,
    now,
  );
  installationTokenCache.clear();
  return true;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
