import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  fetchBeszelTelemetry,
  getBeszelConfigForBackup,
  getBeszelConfigPublic,
  restoreBeszelConfigFromBackup,
  saveBeszelConfig,
} from './server/beszel.ts';
import {
  generateBootstrapScript,
  generatePanelComposeYaml,
  generatePanelDockerfile,
  type BootstrapOptions,
} from './server/bootstrap.ts';
import {
  applyCaddyfile,
  isCaddyAvailable,
  listCaddySnapshots,
  renderManagedRoutesBlock,
  syncProjectsToCaddyfile,
  validateCaddyfile,
  validateDomainString,
} from './server/caddy.ts';
import {
  cleanupProjectWorkspace,
  deployLogBus,
  startBackgroundSchedulers,
  triggerDeployment,
} from './server/cicd.ts';
import {
  decryptBackupPayload,
  decryptSecret,
  encryptBackupPayload,
  encryptSecret,
  generateRandomHex,
  hashPassword,
  isEncryptedBackupEnvelope,
  maskSecret,
  signSessionToken,
  verifyGitHubSignature,
  verifyPassword,
  verifyPlainPasscode,
  verifySessionToken,
} from './server/crypto.ts';
import {
  DEFAULT_CADDYFILE,
  claimAdminPasswordAtomic,
  db,
  getResourcePrivateNetworks,
  getSetting,
  setSetting,
  syncPrimaryNetworkAttachment,
  type CaddySnapshotRow,
  type DeploymentRow,
  type NetworkAttachmentRow,
  type PrivateNetworkRow,
  type ProjectRow,
  type ServiceRow,
  type UserRow,
} from './server/db.ts';
import {
  connectContainerToNetwork,
  createDockerNetwork,
  disconnectContainerFromNetwork,
  ensureDockerNetwork,
  getContainerLogs,
  getContainerStats,
  getDockerDiskUsage,
  getSystemHostMetrics,
  inspectDockerNetwork,
  isDockerAvailable,
  isGitAvailable,
  listDockerContainers,
  performContainerAction,
  probeTargetInNetwork,
  pruneDockerUnused,
  removeDockerNetwork,
} from './server/docker.ts';
import {
  inspectGitHubRepo,
  parseGitHubRepoUrl,
  validateBranchName,
} from './server/github.ts';
import {
  SERVICE_TEMPLATES,
  buildConnectionSummary,
  buildServiceEnvWithDefaults,
  deployServiceInstance,
  findServiceTemplate,
  removeServiceContainer,
  resolveCommandTemplate,
  serializeService,
} from './server/templates.ts';
import { checkForUpdates, getLocalVersionInfo } from './server/updater.ts';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
}

interface AuthenticatedRequest extends Request {
  authUser?: AuthUser;
}

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 3000);

// Baseline security headers (preserve iframe embed compatibility by omitting X-Frame-Options)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// Sliding-window rate limiter for auth endpoints to block brute-force attempts
const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_MAX_FAILURES = 15;
const authFailureBuckets = new Map<string, number[]>();

function getClientIpKey(req: Request): string {
  return String(req.ip || req.socket.remoteAddress || 'unknown');
}

function isAuthRateLimited(req: Request): boolean {
  const key = getClientIpKey(req);
  const now = Date.now();
  const recent = (authFailureBuckets.get(key) ?? []).filter((ts) => now - ts < AUTH_RATE_WINDOW_MS);
  if (recent.length === 0) {
    authFailureBuckets.delete(key);
    return false;
  }
  authFailureBuckets.set(key, recent);
  return recent.length >= AUTH_RATE_MAX_FAILURES;
}

function recordAuthFailure(req: Request): void {
  const key = getClientIpKey(req);
  const now = Date.now();
  const recent = (authFailureBuckets.get(key) ?? []).filter((ts) => now - ts < AUTH_RATE_WINDOW_MS);
  recent.push(now);
  authFailureBuckets.set(key, recent);
  // Periodic bound so map cannot grow indefinitely
  if (authFailureBuckets.size > 5000) {
    for (const [k, list] of authFailureBuckets) {
      if (list.every((ts) => now - ts >= AUTH_RATE_WINDOW_MS)) {
        authFailureBuckets.delete(k);
      }
    }
  }
}

function clearAuthFailures(req: Request): void {
  authFailureBuckets.delete(getClientIpKey(req));
}

// GitHub Webhook route needs exact raw body BEFORE express.json() consumes it
app.post(
  '/api/webhooks/github/:projectId',
  express.raw({ type: 'application/json', limit: '2mb' }),
  async (req: Request, res: Response) => {
    try {
      const projectId = String(req.params.projectId || '');
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
        | ProjectRow
        | undefined;
      if (!project) {
        res.status(404).json({ error: 'پروژه پیدا نشد.' });
        return;
      }
      if (project.auto_deploy_webhook !== 1) {
        res.status(403).json({ error: 'وب‌هوک خودکار برای این پروژه غیرفعال است.' });
        return;
      }

      const secret = decryptSecret(project.webhook_secret_enc);
      if (!secret) {
        res.status(400).json({ error: 'کلید امنیتی وب‌هوک برای این پروژه تنظیم نشده است.' });
        return;
      }

      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      const sig = req.header('x-hub-signature-256');
      if (!verifyGitHubSignature(rawBody, sig, secret)) {
        res.status(401).json({ error: 'امضای دیجیتال وب‌هوک نامعتبر است.' });
        return;
      }

      const eventType = req.header('x-github-event') || 'push';
      if (eventType === 'ping') {
        res.json({ ok: true, message: 'پینگ وب‌هوک با موفقیت دریافت شد.' });
        return;
      }

      const payload = JSON.parse(rawBody.toString('utf8')) as {
        ref?: string;
        source?: string;
        action?: string;
        workflow_run?: { conclusion?: string; head_branch?: string };
      };
      const expectedRef = `refs/heads/${project.branch}`;

      if (eventType === 'workflow_run') {
        if (payload.action !== 'completed' || payload.workflow_run?.conclusion !== 'success') {
          res.json({
            ok: true,
            ignored: true,
            message: 'رویداد workflow_run هنوز به پایان موفق نرسیده است.',
          });
          return;
        }
        if (payload.workflow_run?.head_branch && payload.workflow_run.head_branch !== project.branch) {
          res.json({
            ok: true,
            ignored: true,
            message: `شاخه ${payload.workflow_run.head_branch} با شاخه هدف (${project.branch}) تطابق ندارد.`,
          });
          return;
        }
      } else {
        const isActionsTrigger =
          eventType === 'github_actions_deploy' ||
          eventType === 'workflow_dispatch' ||
          payload.source === 'github_actions';
        if (project.deploy_strategy === 'github_actions' && !isActionsTrigger) {
          res.json({
            ok: true,
            ignored: true,
            message:
              'این پروژه در حالت GitHub Actions است؛ رویداد push خام نادیده گرفته شد تا پس از پایان بیلد اکشنز دیپلوی اجرا شود.',
          });
          return;
        }
        if (payload.ref && payload.ref !== expectedRef) {
          res.json({
            ok: true,
            ignored: true,
            message: `رویداد مربوط به شاخه ${payload.ref} نادیده گرفته شد (شاخه هدف: ${expectedRef}).`,
          });
          return;
        }
      }

      const deployment = await triggerDeployment(project.id, 'webhook');
      res.status(202).json({ ok: true, deploymentId: deployment.id });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'خطا در پردازش وب‌هوک گیتهاب',
      });
    }
  },
);

// Allow larger payloads specifically for full disaster-recovery backup imports
app.use('/api/backup/import', express.json({ limit: '10mb' }));
app.use(express.json({ limit: '2mb' }));

function serializeProject(p: ProjectRow) {
  const token = decryptSecret(p.github_token_enc);
  const webhookSecret = decryptSecret(p.webhook_secret_enc);
  let envKeys: string[] = [];
  try {
    const parsed = JSON.parse(decryptSecret(p.env_vars_enc) || '{}') as Record<string, string>;
    envKeys = Object.keys(parsed);
  } catch {
    envKeys = [];
  }

  const networks = getResourcePrivateNetworks('project', p.id, p.private_network_id).map((n) => ({
    id: n.id,
    name: n.name,
    slug: n.slug,
    dockerName: n.docker_name,
    internalOnly: n.internal_only === 1,
  }));

  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    repoUrl: p.repo_url,
    branch: p.branch,
    buildMode: p.build_mode,
    deployStrategy: p.deploy_strategy === 'github_actions' ? 'github_actions' : 'local',
    ghcrImage: p.ghcr_image || '',
    actionsComposeFile: p.actions_compose_file || '',
    buildFilePath: p.build_file_path,
    dockerfileContext: p.dockerfile_context,
    containerPort: p.container_port,
    domain: p.domain,
    caddyEnabled: p.caddy_enabled === 1,
    caddyExtraDirectives: p.caddy_extra_directives,
    autoDeployWebhook: p.auto_deploy_webhook === 1,
    pollingIntervalSec: p.polling_interval_sec,
    lastPolledAt: p.last_polled_at,
    hasGithubToken: Boolean(token),
    githubTokenMasked: maskSecret(token),
    hasWebhookSecret: Boolean(webhookSecret),
    webhookSecretMasked: maskSecret(webhookSecret),
    envKeys,
    lastCommitSha: p.last_commit_sha,
    lastCommitMsg: p.last_commit_msg,
    lastDeployedAt: p.last_deployed_at,
    status: p.status,
    ownerUserId: p.owner_user_id,
    privateNetworkId: p.private_network_id,
    networks,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

function findDomainConflict(
  domain: string,
  exclude?: { projectId?: string; serviceId?: string },
): string | null {
  const normalized = domain.trim().toLowerCase();
  if (!normalized) return null;
  const proj = exclude?.projectId
    ? (db
        .prepare('SELECT name FROM projects WHERE LOWER(domain) = ? AND caddy_enabled = 1 AND id != ?')
        .get(normalized, exclude.projectId) as { name: string } | undefined)
    : (db
        .prepare('SELECT name FROM projects WHERE LOWER(domain) = ? AND caddy_enabled = 1')
        .get(normalized) as { name: string } | undefined);
  if (proj) return `پروژه «${proj.name}»`;

  const svc = exclude?.serviceId
    ? (db
        .prepare('SELECT name FROM services WHERE LOWER(domain) = ? AND caddy_enabled = 1 AND id != ?')
        .get(normalized, exclude.serviceId) as { name: string } | undefined)
    : (db
        .prepare('SELECT name FROM services WHERE LOWER(domain) = ? AND caddy_enabled = 1')
        .get(normalized) as { name: string } | undefined);
  if (svc) return `سرویس «${svc.name}»`;
  return null;
}

const SESSION_COOKIE_NAME = 'sokkan_session';
const LEGACY_SESSION_COOKIE_NAME = 'sokanyar_session';
const SESSION_TTL_DAYS = Math.max(1, Math.min(90, Number(process.env.SESSION_TTL_DAYS || 30)));
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

function readCookieValue(req: Request, cookieName: string): string {
  const header = req.header('cookie');
  if (!header) return '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === cookieName) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return part.slice(idx + 1).trim();
      }
    }
  }
  return '';
}

function isHttpsRequest(req: Request): boolean {
  const forwardedProto = (req.header('x-forwarded-proto') ?? '').split(',')[0].trim().toLowerCase();
  return req.secure || forwardedProto === 'https';
}

function setSessionCookie(req: Request, res: Response, token: string): void {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  const https = isHttpsRequest(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    https ? 'SameSite=None' : 'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (https) {
    parts.push('Secure');
    parts.push('Partitioned');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req: Request, res: Response): void {
  const https = isHttpsRequest(req);
  const suffix = https ? 'SameSite=None; Secure; Partitioned' : 'SameSite=Lax';
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; ${suffix}; Max-Age=0`,
    `${LEGACY_SESSION_COOKIE_NAME}=; Path=/; HttpOnly; ${suffix}; Max-Age=0`,
  ]);
}

function extractPanelToken(req: Request): { token: string; fromCookie: boolean } {
  const customHeader = req.header('x-panel-token')?.trim();
  if (customHeader) {
    return { token: customHeader, fromCookie: false };
  }
  const authHeader = req.header('authorization') ?? '';
  if (authHeader.startsWith('Bearer ')) {
    return { token: authHeader.slice('Bearer '.length).trim(), fromCookie: false };
  }
  const cookieToken =
    readCookieValue(req, SESSION_COOKIE_NAME) || readCookieValue(req, LEGACY_SESSION_COOKIE_NAME);
  if (cookieToken) {
    return { token: cookieToken, fromCookie: true };
  }
  return { token: '', fromCookie: false };
}

function isSameOriginMutation(req: Request): boolean {
  const origin = req.header('origin');
  if (!origin) return true;
  const host = (req.header('x-forwarded-host') || req.header('host') || '').split(',')[0].trim().toLowerCase();
  if (!host) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function getAuthState() {
  const envPasscode = process.env.PANEL_ADMIN_PASSCODE?.trim() ?? '';
  const claimedHash = getSetting('admin_password_hash');
  const hasAdminUser = Boolean(
    db.prepare("SELECT id FROM users WHERE username = 'admin'").get(),
  );
  return {
    envPasscodeActive: envPasscode.length > 0,
    needsSetup: envPasscode.length === 0 && !claimedHash && !hasAdminUser,
  };
}

function resolveSessionUser(token: string): AuthUser | null {
  const payload = verifySessionToken(token);
  if (!payload) return null;

  const envPasscode = process.env.PANEL_ADMIN_PASSCODE?.trim() ?? '';
  const targetUserId = payload.userId || (payload.role === 'admin' ? 'usr_admin' : '');
  if (!targetUserId) return null;

  if (envPasscode.length > 0 && targetUserId === 'usr_admin') {
    return {
      id: 'usr_admin',
      username: 'admin',
      displayName: 'مدیر کل سیستم',
      role: 'admin',
    };
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId) as UserRow | undefined;
  if (!user || user.is_active !== 1) {
    return null;
  }
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role === 'admin' ? 'admin' : 'member',
  };
}

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const { token, fromCookie } = extractPanelToken(req);
  if (!token) {
    res.status(401).json({ error: 'احراز هویت کاربری الزامی است.' });
    return;
  }
  if (
    fromCookie &&
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase()) &&
    !req.header('x-requested-with') &&
    !isSameOriginMutation(req)
  ) {
    res.status(403).json({ error: 'درخواست نامعتبر (Origin غیرمجاز).' });
    return;
  }
  const user = resolveSessionUser(token);
  if (!user) {
    res.status(401).json({ error: 'نشست کاربری منقضی شده، غیرفعال شده یا نامعتبر است.' });
    return;
  }
  req.authUser = user;
  next();
}

function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.authUser || req.authUser.role !== 'admin') {
    res.status(403).json({ error: 'انجام این عملیات فقط برای مدیر کل سیستم مجاز است.' });
    return;
  }
  next();
}

function canAccessResource(user: AuthUser, ownerUserId: string): boolean {
  return user.role === 'admin' || ownerUserId === user.id;
}

function validatePrivateNetworkAssignment(
  user: AuthUser,
  networkId: string | null | undefined,
): PrivateNetworkRow | null {
  if (!networkId || !networkId.trim()) return null;
  const net = db
    .prepare('SELECT * FROM private_networks WHERE id = ?')
    .get(networkId.trim()) as PrivateNetworkRow | undefined;
  if (!net) {
    throw new Error('شبکه خصوصی انتخاب‌شده پیدا نشد.');
  }
  if (!canAccessResource(user, net.owner_user_id)) {
    throw new Error('شما مجوز استفاده از این شبکه خصوصی را ندارید.');
  }
  return net;
}

function isValidPrivateSubnet(subnet: string): boolean {
  const trimmed = subnet.trim();
  const match = trimmed.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(16|20|22|24|25|26|27|28)$/);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  const c = Number(match[3]);
  const d = Number(match[4]);
  if ([a, b, c, d].some((n) => n < 0 || n > 255)) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function getUserOwnedContainerSlugs(userId: string): Set<string> {
  const projs = db.prepare('SELECT slug FROM projects WHERE owner_user_id = ?').all(userId) as Array<{
    slug: string;
  }>;
  const svcs = db.prepare('SELECT slug FROM services WHERE owner_user_id = ?').all(userId) as Array<{
    slug: string;
  }>;
  const set = new Set<string>();
  for (const p of projs) set.add(`sokkan-${p.slug}`);
  for (const s of svcs) set.add(`sokkan-${s.slug}`);
  return set;
}

function canAccessContainer(
  user: AuthUser,
  containerName: string,
  ownerLabel?: string,
): boolean {
  if (user.role === 'admin') return true;
  if (['caddy', 'sokkan-panel', 'beszel', 'beszel-agent'].includes(containerName)) {
    return false;
  }
  if (ownerLabel && ownerLabel === user.id) return true;
  const ownedNames = getUserOwnedContainerSlugs(user.id);
  return ownedNames.has(containerName);
}

// Public Health & Auth Routes
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    version: getLocalVersionInfo().version,
    time: new Date().toISOString(),
  });
});

app.get('/api/auth/status', (req, res) => {
  const { envPasscodeActive, needsSetup } = getAuthState();
  const { token } = extractPanelToken(req);
  const user = token ? resolveSessionUser(token) : null;
  const caddyUser = (req.header('x-forwarded-user') ?? '').trim();
  res.json({
    authenticated: Boolean(user),
    needsSetup,
    envPasscodeActive,
    caddyUser: caddyUser || undefined,
    user: user || undefined,
  });
});

app.post('/api/auth/setup', (req, res) => {
  if (isAuthRateLimited(req)) {
    res.status(429).json({ error: 'تعداد تلاش‌های ناموفق بیش از حد مجاز است. لطفاً چند دقیقه دیگر دوباره تلاش کنید.' });
    return;
  }
  const { envPasscodeActive, needsSetup } = getAuthState();
  if (envPasscodeActive || !needsSetup) {
    recordAuthFailure(req);
    res.status(409).json({ error: 'رمز مدیر قبلاً تنظیم شده است.' });
    return;
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (password.length < 8) {
    res.status(400).json({ error: 'رمز عبور باید حداقل ۸ کاراکتر باشد.' });
    return;
  }
  const hash = hashPassword(password);
  const claimed = claimAdminPasswordAtomic(hash);
  if (!claimed) {
    recordAuthFailure(req);
    res.status(409).json({ error: 'رمز مدیر قبلاً ثبت شده است.' });
    return;
  }
  clearAuthFailures(req);
  const exp = Date.now() + SESSION_TTL_MS;
  const user: AuthUser = {
    id: 'usr_admin',
    username: 'admin',
    displayName: 'مدیر کل سیستم',
    role: 'admin',
  };
  const token = signSessionToken({
    userId: user.id,
    username: user.username,
    role: user.role,
    exp,
  });
  setSessionCookie(req, res, token);
  res.status(201).json({ token, expiresAt: exp, user });
});

app.post('/api/auth/login', (req, res) => {
  if (isAuthRateLimited(req)) {
    res.status(429).json({
      error: 'تعداد تلاش‌های ناموفق ورود بیش از حد مجاز است. لطفاً ۱۵ دقیقه دیگر مجدداً تلاش کنید.',
    });
    return;
  }

  const rawUsername = typeof req.body?.username === 'string' ? req.body.username : 'admin';
  const username = rawUsername.trim().toLowerCase() || 'admin';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password) {
    res.status(400).json({ error: 'رمز عبور را وارد کنید.' });
    return;
  }

  const envPasscode = process.env.PANEL_ADMIN_PASSCODE?.trim() ?? '';
  let authenticatedUser: AuthUser | null = null;

  if (username === 'admin' && envPasscode.length > 0) {
    if (verifyPlainPasscode(password, envPasscode)) {
      authenticatedUser = {
        id: 'usr_admin',
        username: 'admin',
        displayName: 'مدیر کل سیستم',
        role: 'admin',
      };
    }
  } else {
    const row = db
      .prepare('SELECT * FROM users WHERE LOWER(username) = ?')
      .get(username) as UserRow | undefined;

    if (row) {
      if (row.is_active !== 1) {
        recordAuthFailure(req);
        res.status(403).json({ error: 'این حساب کاربری توسط مدیر غیرفعال شده است.' });
        return;
      }
      if (row.password_hash && verifyPassword(password, row.password_hash)) {
        authenticatedUser = {
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          role: row.role === 'admin' ? 'admin' : 'member',
        };
      }
    } else if (username === 'admin') {
      const legacyHash = getSetting('admin_password_hash');
      if (!legacyHash) {
        res.status(400).json({ error: 'ابتدا رمز مدیر را در فرم راه‌اندازی اولیه ثبت کنید.' });
        return;
      }
      if (verifyPassword(password, legacyHash)) {
        authenticatedUser = {
          id: 'usr_admin',
          username: 'admin',
          displayName: 'مدیر کل سیستم',
          role: 'admin',
        };
      }
    }
  }

  if (!authenticatedUser) {
    recordAuthFailure(req);
    res.status(401).json({ error: 'نام کاربری یا رمز عبور نادرست است.' });
    return;
  }

  clearAuthFailures(req);
  const exp = Date.now() + SESSION_TTL_MS;
  const token = signSessionToken({
    userId: authenticatedUser.id,
    username: authenticatedUser.username,
    role: authenticatedUser.role,
    exp,
  });
  setSessionCookie(req, res, token);
  res.json({ token, expiresAt: exp, user: authenticatedUser });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.post('/api/auth/change-password', requireAuth, (req: AuthenticatedRequest, res) => {
  const user = req.authUser!;
  const envPasscode = process.env.PANEL_ADMIN_PASSCODE?.trim() ?? '';
  if (user.id === 'usr_admin' && envPasscode.length > 0) {
    res.status(400).json({
      error: 'رمز مدیر از طریق متغیر محیطی PANEL_ADMIN_PASSCODE تنظیم شده و از اینجا قابل تغییر نیست.',
    });
    return;
  }

  const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
  if (newPassword.length < 8) {
    res.status(400).json({ error: 'رمز عبور جدید باید حداقل ۸ کاراکتر باشد.' });
    return;
  }

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as UserRow | undefined;
  if (!row || !verifyPassword(currentPassword, row.password_hash)) {
    res.status(401).json({ error: 'رمز عبور فعلی نادرست است.' });
    return;
  }

  const nextHash = hashPassword(newPassword);
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    nextHash,
    now,
    user.id,
  );
  if (user.id === 'usr_admin') {
    db.prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?').run(
      nextHash,
      now,
      'admin_password_hash',
    );
  }
  res.json({ ok: true });
});

// Admin Users Management
app.get('/api/users', requireAuth, requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];
  const serialized = rows.map((u) => {
    const networksCount = (
      db
        .prepare('SELECT COUNT(*) as c FROM private_networks WHERE owner_user_id = ?')
        .get(u.id) as { c: number }
    ).c;
    const projectsCount = (
      db
        .prepare('SELECT COUNT(*) as c FROM projects WHERE owner_user_id = ?')
        .get(u.id) as { c: number }
    ).c;
    const servicesCount = (
      db
        .prepare('SELECT COUNT(*) as c FROM services WHERE owner_user_id = ?')
        .get(u.id) as { c: number }
    ).c;
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      role: u.role,
      isActive: u.is_active === 1,
      networksCount,
      projectsCount,
      servicesCount,
      createdAt: u.created_at,
      updatedAt: u.updated_at,
    };
  });
  res.json(serialized);
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  try {
    const body = req.body ?? {};
    const username = String(body.username || '').trim().toLowerCase();
    const displayName = String(body.displayName || '').trim() || username;
    const password = typeof body.password === 'string' ? body.password : '';
    const role: 'admin' | 'member' = body.role === 'admin' ? 'admin' : 'member';

    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
      res.status(400).json({
        error: 'نام کاربری باید بین ۳ تا ۳۲ کاراکتر و شامل حروف کوچک انگلیسی، عدد، خط تیره یا نقطه باشد.',
      });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'رمز عبور کاربر باید حداقل ۸ کاراکتر باشد.' });
      return;
    }

    const exists = db.prepare('SELECT id FROM users WHERE LOWER(username) = ?').get(username);
    if (exists) {
      res.status(409).json({ error: `نام کاربری «${username}» قبلاً ثبت شده است.` });
      return;
    }

    const id = `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    const hash = hashPassword(password);

    db.prepare(
      `INSERT INTO users (id, username, display_name, role, password_hash, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, username, displayName, role, hash, now, now);

    res.status(201).json({
      id,
      username,
      displayName,
      role,
      isActive: true,
      networksCount: 0,
      projectsCount: 0,
      servicesCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'خطا در ایجاد کاربر' });
  }
});

app.patch('/api/users/:id', requireAuth, requireAdmin, (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id || '');
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'کاربر پیدا نشد.' });
    return;
  }

  const body = req.body ?? {};
  const nextDisplayName =
    body.displayName !== undefined ? String(body.displayName).trim() || existing.display_name : existing.display_name;
  const nextRole: 'admin' | 'member' =
    body.role === 'admin' || body.role === 'member' ? body.role : existing.role;
  const nextActive =
    body.isActive !== undefined ? (body.isActive ? 1 : 0) : existing.is_active;

  if (existing.id === 'usr_admin' && (nextRole !== 'admin' || nextActive !== 1)) {
    res.status(400).json({ error: 'امکان غیرفعال کردن یا تغییر نقش مدیر اصلی سیستم وجود ندارد.' });
    return;
  }
  if (req.authUser?.id === id && (nextRole !== 'admin' || nextActive !== 1)) {
    res.status(400).json({ error: 'نمی‌توانید حساب کاربری فعلی خودتان را غیرفعال یا از حالت ادمین خارج کنید.' });
    return;
  }

  let nextHash = existing.password_hash;
  if (typeof body.password === 'string' && body.password.length > 0) {
    const envPasscode = process.env.PANEL_ADMIN_PASSCODE?.trim() ?? '';
    if (id === 'usr_admin' && envPasscode.length > 0) {
      res.status(400).json({
        error: 'رمز مدیر اصلی از طریق متغیر محیطی PANEL_ADMIN_PASSCODE تنظیم شده و از پنل قابل تغییر نیست.',
      });
      return;
    }
    if (body.password.length < 8) {
      res.status(400).json({ error: 'رمز عبور جدید باید حداقل ۸ کاراکتر باشد.' });
      return;
    }
    nextHash = hashPassword(body.password);
  }

  const now = new Date().toISOString();
  db.prepare(
    'UPDATE users SET display_name = ?, role = ?, is_active = ?, password_hash = ?, updated_at = ? WHERE id = ?',
  ).run(nextDisplayName, nextRole, nextActive, nextHash, now, id);

  if (id === 'usr_admin' && nextHash !== existing.password_hash) {
    setSetting('admin_password_hash', nextHash);
  }

  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id || '');
  if (id === 'usr_admin' || id === req.authUser?.id) {
    res.status(400).json({ error: 'امکان حذف مدیر اصلی یا حساب کاربری فعلی وجود ندارد.' });
    return;
  }
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'کاربر پیدا نشد.' });
    return;
  }

  const pCount = (db.prepare('SELECT COUNT(*) as c FROM projects WHERE owner_user_id = ?').get(id) as { c: number }).c;
  const sCount = (db.prepare('SELECT COUNT(*) as c FROM services WHERE owner_user_id = ?').get(id) as { c: number }).c;
  const nCount = (db.prepare('SELECT COUNT(*) as c FROM private_networks WHERE owner_user_id = ?').get(id) as { c: number }).c;
  if (pCount > 0 || sCount > 0 || nCount > 0) {
    res.status(409).json({
      error: `این کاربر هنوز دارای ${nCount} شبکه خصوصی، ${pCount} پروژه و ${sCount} سرویس فعال است. ابتدا منابع او را حذف کنید.`,
    });
    return;
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Private Networks Management (User-Scoped + Admin Overview)
async function serializePrivateNetwork(net: PrivateNetworkRow) {
  const owner = db
    .prepare('SELECT username, display_name FROM users WHERE id = ?')
    .get(net.owner_user_id) as { username: string; display_name: string } | undefined;

  const attachedProjects = db
    .prepare(
      `SELECT DISTINCT p.* FROM projects p
       LEFT JOIN network_attachments na
         ON na.resource_type = 'project' AND na.resource_id = p.id
       WHERE p.private_network_id = ? OR na.network_id = ?
       ORDER BY p.created_at DESC`,
    )
    .all(net.id, net.id) as ProjectRow[];

  const attachedServices = db
    .prepare(
      `SELECT DISTINCT s.* FROM services s
       LEFT JOIN network_attachments na
         ON na.resource_type = 'service' AND na.resource_id = s.id
       WHERE s.private_network_id = ? OR na.network_id = ?
       ORDER BY s.created_at DESC`,
    )
    .all(net.id, net.id) as ServiceRow[];

  const dockerInspect = await inspectDockerNetwork(net.docker_name);
  const ipByContainer = new Map<string, string>();
  if (dockerInspect) {
    for (const c of dockerInspect.containers) {
      ipByContainer.set(c.name, c.ipv4Address);
    }
  }

  return {
    id: net.id,
    name: net.name,
    slug: net.slug,
    dockerName: net.docker_name,
    ownerUserId: net.owner_user_id,
    ownerUsername: owner?.username ?? 'admin',
    ownerDisplayName: owner?.display_name ?? 'مدیر کل سیستم',
    description: net.description,
    subnet: dockerInspect?.subnet || net.subnet,
    internalOnly: net.internal_only === 1,
    dockerExists: Boolean(dockerInspect),
    dockerContainerCount: dockerInspect?.containers.length ?? 0,
    projects: attachedProjects.map((p) => {
      const containerName = `sokkan-${p.slug}`;
      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        containerName,
        containerPort: p.container_port,
        domain: p.domain,
        caddyEnabled: p.caddy_enabled === 1,
        status: p.status,
        internalHost: `${containerName}:${p.container_port}`,
        aliasHost: `${p.slug}:${p.container_port}`,
        ipv4Address: ipByContainer.get(containerName) || null,
        isPrimaryNetwork: p.private_network_id === net.id,
      };
    }),
    services: attachedServices.map((s) => {
      const serialized = serializeService(s);
      return {
        id: s.id,
        templateId: s.template_id,
        name: s.name,
        slug: s.slug,
        category: s.category,
        containerName: serialized.containerName,
        containerPort: s.container_port,
        domain: s.domain,
        caddyEnabled: s.caddy_enabled === 1,
        status: s.status,
        internalHost: serialized.internalHost,
        aliasHost: `${s.slug}:${s.container_port}`,
        connectionUrl: serialized.connectionUrl,
        ipv4Address: ipByContainer.get(serialized.containerName) || null,
        isPrimaryNetwork: s.private_network_id === net.id,
      };
    }),
    createdAt: net.created_at,
    updatedAt: net.updated_at,
  };
}

app.get('/api/networks', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.authUser!;
    const rows =
      user.role === 'admin'
        ? (db.prepare('SELECT * FROM private_networks ORDER BY created_at DESC').all() as PrivateNetworkRow[])
        : (db
            .prepare('SELECT * FROM private_networks WHERE owner_user_id = ? ORDER BY created_at DESC')
            .all(user.id) as PrivateNetworkRow[]);

    const serialized = await Promise.all(rows.map(serializePrivateNetwork));
    res.json(serialized);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'خطا در دریافت لیست شبکه‌های خصوصی',
    });
  }
});

app.post('/api/networks', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.authUser!;
    const body = req.body ?? {};
    const name = String(body.name || '').trim();
    const rawSlug = String(body.slug || name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');

    if (!name) {
      res.status(400).json({ error: 'نام نمایشی شبکه الزامی است.' });
      return;
    }
    if (!rawSlug || !/^[a-z0-9-]{2,36}$/.test(rawSlug)) {
      res.status(400).json({
        error: 'شناسه انگلیسی شبکه باید بین ۲ تا ۳۶ کاراکتر و شامل حروف کوچک، عدد و خط تیره باشد.',
      });
      return;
    }

    const dockerName = `sokkan-net-${rawSlug}`;
    const duplicate = db
      .prepare('SELECT id FROM private_networks WHERE slug = ? OR docker_name = ?')
      .get(rawSlug, dockerName);
    if (duplicate) {
      res.status(409).json({ error: `شبکه‌ای با شناسه «${rawSlug}» از قبل وجود دارد.` });
      return;
    }

    const subnet = typeof body.subnet === 'string' ? body.subnet.trim() : '';
    if (subnet && !isValidPrivateSubnet(subnet)) {
      res.status(400).json({
        error: 'رنج Subnet باید در محدوده IP خصوصی (مانند 172.28.10.0/24 یا 10.20.0.0/24) باشد.',
      });
      return;
    }

    const description = String(body.description || '').trim();
    const internalOnly = Boolean(body.internalOnly);

    const dockerUp = await isDockerAvailable();
    if (dockerUp) {
      await createDockerNetwork(dockerName, {
        internal: internalOnly,
        subnet: subnet || undefined,
        ownerUserId: user.id,
      });
    }

    const id = `net_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO private_networks (
        id, name, slug, docker_name, owner_user_id, description, subnet, internal_only, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, rawSlug, dockerName, user.id, description, subnet, internalOnly ? 1 : 0, now, now);

    const created = db.prepare('SELECT * FROM private_networks WHERE id = ?').get(id) as PrivateNetworkRow;
    res.status(201).json(await serializePrivateNetwork(created));
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در ایجاد شبکه خصوصی',
    });
  }
});

app.patch('/api/networks/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id || '');
  const existing = db.prepare('SELECT * FROM private_networks WHERE id = ?').get(id) as
    | PrivateNetworkRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'شبکه خصوصی پیدا نشد.' });
    return;
  }
  if (!canAccessResource(req.authUser!, existing.owner_user_id)) {
    res.status(403).json({ error: 'شما مجوز ویرایش این شبکه خصوصی را ندارید.' });
    return;
  }

  const body = req.body ?? {};
  const name = body.name !== undefined ? String(body.name).trim() || existing.name : existing.name;
  const description =
    body.description !== undefined ? String(body.description).trim() : existing.description;

  db.prepare('UPDATE private_networks SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(
    name,
    description,
    new Date().toISOString(),
    id,
  );

  const updated = db.prepare('SELECT * FROM private_networks WHERE id = ?').get(id) as PrivateNetworkRow;
  res.json(await serializePrivateNetwork(updated));
});

app.delete('/api/networks/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id || '');
  const existing = db.prepare('SELECT * FROM private_networks WHERE id = ?').get(id) as
    | PrivateNetworkRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'شبکه خصوصی پیدا نشد.' });
    return;
  }
  if (!canAccessResource(req.authUser!, existing.owner_user_id)) {
    res.status(403).json({ error: 'شما مجوز حذف این شبکه خصوصی را ندارید.' });
    return;
  }

  const dockerUp = await isDockerAvailable();
  if (dockerUp) {
    await removeDockerNetwork(existing.docker_name);
  }

  db.prepare('UPDATE projects SET private_network_id = NULL WHERE private_network_id = ?').run(id);
  db.prepare('UPDATE services SET private_network_id = NULL WHERE private_network_id = ?').run(id);
  db.prepare('DELETE FROM private_networks WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/networks/:id/attach', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = String(req.params.id || '');
    const net = db.prepare('SELECT * FROM private_networks WHERE id = ?').get(id) as
      | PrivateNetworkRow
      | undefined;
    if (!net) {
      res.status(404).json({ error: 'شبکه خصوصی پیدا نشد.' });
      return;
    }
    if (!canAccessResource(req.authUser!, net.owner_user_id)) {
      res.status(403).json({ error: 'شما مجوز تغییر این شبکه خصوصی را ندارید.' });
      return;
    }

    const resourceType = req.body?.resourceType === 'service' ? 'service' : 'project';
    const resourceId = String(req.body?.resourceId || '').trim();
    if (!resourceId) {
      res.status(400).json({ error: 'شناسه سرویس یا پروژه الزامی است.' });
      return;
    }

    const row =
      resourceType === 'project'
        ? (db.prepare('SELECT * FROM projects WHERE id = ?').get(resourceId) as ProjectRow | undefined)
        : (db.prepare('SELECT * FROM services WHERE id = ?').get(resourceId) as ServiceRow | undefined);

    if (!row) {
      res.status(404).json({ error: 'پروژه یا سرویس انتخاب‌شده پیدا نشد.' });
      return;
    }
    if (!canAccessResource(req.authUser!, row.owner_user_id)) {
      res.status(403).json({ error: 'شما مجوز اتصال این منبع به شبکه خصوصی را ندارید.' });
      return;
    }

    const now = new Date().toISOString();
    const attId = `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(
      `INSERT INTO network_attachments (id, network_id, resource_type, resource_id, alias, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(network_id, resource_type, resource_id) DO NOTHING`,
    ).run(attId, net.id, resourceType, row.id, row.slug, now);

    if (!row.private_network_id) {
      db.prepare(
        `UPDATE ${resourceType === 'project' ? 'projects' : 'services'} SET private_network_id = ?, updated_at = ? WHERE id = ?`,
      ).run(net.id, now, row.id);
    }

    const dockerUp = await isDockerAvailable();
    if (dockerUp) {
      await ensureDockerNetwork(net.docker_name, {
        internal: net.internal_only === 1,
        subnet: net.subnet || undefined,
        ownerUserId: net.owner_user_id,
      });
      await connectContainerToNetwork(`sokkan-${row.slug}`, net.docker_name, [row.slug]);
    }

    const refreshed = db.prepare('SELECT * FROM private_networks WHERE id = ?').get(net.id) as PrivateNetworkRow;
    res.json(await serializePrivateNetwork(refreshed));
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در اتصال منبع به شبکه خصوصی',
    });
  }
});

app.post('/api/networks/:id/detach', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = String(req.params.id || '');
    const net = db.prepare('SELECT * FROM private_networks WHERE id = ?').get(id) as
      | PrivateNetworkRow
      | undefined;
    if (!net) {
      res.status(404).json({ error: 'شبکه خصوصی پیدا نشد.' });
      return;
    }
    if (!canAccessResource(req.authUser!, net.owner_user_id)) {
      res.status(403).json({ error: 'شما مجوز تغییر این شبکه خصوصی را ندارید.' });
      return;
    }

    const resourceType = req.body?.resourceType === 'service' ? 'service' : 'project';
    const resourceId = String(req.body?.resourceId || '').trim();
    const row =
      resourceType === 'project'
        ? (db.prepare('SELECT * FROM projects WHERE id = ?').get(resourceId) as ProjectRow | undefined)
        : (db.prepare('SELECT * FROM services WHERE id = ?').get(resourceId) as ServiceRow | undefined);

    if (!row || !canAccessResource(req.authUser!, row.owner_user_id)) {
      res.status(404).json({ error: 'منبع موردنظر پیدا نشد.' });
      return;
    }

    db.prepare(
      'DELETE FROM network_attachments WHERE network_id = ? AND resource_type = ? AND resource_id = ?',
    ).run(net.id, resourceType, row.id);

    if (row.private_network_id === net.id) {
      const fallbackAtt = db
        .prepare(
          'SELECT network_id FROM network_attachments WHERE resource_type = ? AND resource_id = ? LIMIT 1',
        )
        .get(resourceType, row.id) as { network_id: string } | undefined;
      db.prepare(
        `UPDATE ${resourceType === 'project' ? 'projects' : 'services'} SET private_network_id = ?, updated_at = ? WHERE id = ?`,
      ).run(fallbackAtt?.network_id ?? null, new Date().toISOString(), row.id);
    }

    const dockerUp = await isDockerAvailable();
    if (dockerUp) {
      await disconnectContainerFromNetwork(`sokkan-${row.slug}`, net.docker_name);
    }

    const refreshed = db.prepare('SELECT * FROM private_networks WHERE id = ?').get(net.id) as PrivateNetworkRow;
    res.json(await serializePrivateNetwork(refreshed));
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در قطع اتصال از شبکه خصوصی',
    });
  }
});

app.post('/api/networks/:id/inject-env', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = String(req.params.id || '');
    const net = db.prepare('SELECT * FROM private_networks WHERE id = ?').get(id) as
      | PrivateNetworkRow
      | undefined;
    if (!net) {
      res.status(404).json({ error: 'شبکه خصوصی پیدا نشد.' });
      return;
    }
    if (!canAccessResource(req.authUser!, net.owner_user_id)) {
      res.status(403).json({ error: 'شما مجوز دسترسی به این شبکه خصوصی را ندارید.' });
      return;
    }

    const sourceType = req.body?.sourceType === 'project' ? 'project' : 'service';
    const sourceId = String(req.body?.sourceId || '').trim();
    const targetProjectId = String(req.body?.targetProjectId || '').trim();
    const redeploy = Boolean(req.body?.redeploy);

    const targetProject = db.prepare('SELECT * FROM projects WHERE id = ?').get(targetProjectId) as
      | ProjectRow
      | undefined;
    if (!targetProject || !canAccessResource(req.authUser!, targetProject.owner_user_id)) {
      res.status(404).json({ error: 'پروژه مقصد پیدا نشد.' });
      return;
    }

    let suggestedKey = 'SERVICE_URL';
    let injectedValue = '';

    if (sourceType === 'service') {
      const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(sourceId) as
        | ServiceRow
        | undefined;
      if (!svc || !canAccessResource(req.authUser!, svc.owner_user_id)) {
        res.status(404).json({ error: 'سرویس مبدا پیدا نشد.' });
        return;
      }
      let envMap: Record<string, string> = {};
      try {
        envMap = JSON.parse(decryptSecret(svc.env_vars_enc) || '{}') as Record<string, string>;
      } catch {
        envMap = {};
      }
      const summary = buildConnectionSummary(svc, envMap);
      injectedValue =
        svc.category === 'database' ? summary.connectionUrl : `http://sokkan-${svc.slug}:${svc.container_port}`;
      suggestedKey =
        svc.template_id === 'postgres' || svc.template_id === 'mariadb'
          ? 'DATABASE_URL'
          : svc.template_id === 'redis'
            ? 'REDIS_URL'
            : svc.template_id === 'mongodb'
              ? 'MONGODB_URI'
              : `${svc.slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_URL`;
    } else {
      const srcProj = db.prepare('SELECT * FROM projects WHERE id = ?').get(sourceId) as
        | ProjectRow
        | undefined;
      if (!srcProj || !canAccessResource(req.authUser!, srcProj.owner_user_id)) {
        res.status(404).json({ error: 'پروژه مبدا پیدا نشد.' });
        return;
      }
      injectedValue = `http://sokkan-${srcProj.slug}:${srcProj.container_port}`;
      suggestedKey = `${srcProj.slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_URL`;
    }

    const customKey = typeof req.body?.envVarName === 'string' ? req.body.envVarName.trim() : '';
    const finalKey = customKey || suggestedKey;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(finalKey)) {
      res.status(400).json({ error: 'نام متغیر محیطی معتبر نیست.' });
      return;
    }

    // Ensure target project is attached to this private network so DNS resolves cleanly
    const now = new Date().toISOString();
    const attId = `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(
      `INSERT INTO network_attachments (id, network_id, resource_type, resource_id, alias, created_at)
       VALUES (?, ?, 'project', ?, ?, ?)
       ON CONFLICT(network_id, resource_type, resource_id) DO NOTHING`,
    ).run(attId, net.id, targetProject.id, targetProject.slug, now);

    if (!targetProject.private_network_id) {
      db.prepare('UPDATE projects SET private_network_id = ?, updated_at = ? WHERE id = ?').run(
        net.id,
        now,
        targetProject.id,
      );
    }

    const currentEnv = JSON.parse(decryptSecret(targetProject.env_vars_enc) || '{}') as Record<
      string,
      string
    >;
    currentEnv[finalKey] = injectedValue;

    db.prepare('UPDATE projects SET env_vars_enc = ?, updated_at = ? WHERE id = ?').run(
      encryptSecret(JSON.stringify(currentEnv)),
      now,
      targetProject.id,
    );

    const dockerUp = await isDockerAvailable();
    if (dockerUp) {
      await ensureDockerNetwork(net.docker_name, {
        internal: net.internal_only === 1,
        subnet: net.subnet || undefined,
        ownerUserId: net.owner_user_id,
      });
      await connectContainerToNetwork(`sokkan-${targetProject.slug}`, net.docker_name, [
        targetProject.slug,
      ]);
    }

    let deploymentId: string | undefined;
    if (redeploy) {
      const dep = await triggerDeployment(targetProject.id, 'manual');
      deploymentId = dep.id;
    }

    res.json({
      ok: true,
      envVarName: finalKey,
      targetProjectName: targetProject.name,
      deploymentId,
      message: `متغیر ${finalKey} به پروژه «${targetProject.name}» روی شبکه «${net.name}» تزریق شد.`,
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در اتصال سرویس به پروژه',
    });
  }
});

app.post('/api/networks/:id/test-request', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = String(req.params.id || '');
    const net = db.prepare('SELECT * FROM private_networks WHERE id = ?').get(id) as
      | PrivateNetworkRow
      | undefined;
    if (!net) {
      res.status(404).json({ error: 'شبکه خصوصی پیدا نشد.' });
      return;
    }
    if (!canAccessResource(req.authUser!, net.owner_user_id)) {
      res.status(403).json({ error: 'شما مجوز تست اتصال در این شبکه را ندارید.' });
      return;
    }

    const targetType = req.body?.targetType === 'project' ? 'project' : 'service';
    const targetId = String(req.body?.targetId || '').trim();
    const methodRaw = String(req.body?.method || 'GET').toUpperCase();
    const method: 'GET' | 'POST' | 'TCP' =
      methodRaw === 'POST' ? 'POST' : methodRaw === 'TCP' ? 'TCP' : 'GET';
    const reqPath = typeof req.body?.path === 'string' && req.body.path.trim() ? req.body.path.trim() : '/';
    if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@/?%-]*$/.test(reqPath)) {
      res.status(400).json({ error: 'مسیر درخواست (Path) باید با / شروع شده و فقط شامل کاراکترهای مجاز URL باشد.' });
      return;
    }

    const isAttached = Boolean(
      db
        .prepare(
          'SELECT id FROM network_attachments WHERE network_id = ? AND resource_type = ? AND resource_id = ?',
        )
        .get(net.id, targetType, targetId),
    );

    const row =
      targetType === 'project'
        ? (db.prepare('SELECT * FROM projects WHERE id = ?').get(targetId) as ProjectRow | undefined)
        : (db.prepare('SELECT * FROM services WHERE id = ?').get(targetId) as ServiceRow | undefined);

    if (!row || !canAccessResource(req.authUser!, row.owner_user_id)) {
      res.status(404).json({ error: 'سرویس یا پروژه مقصد پیدا نشد.' });
      return;
    }
    if (!isAttached && row.private_network_id !== net.id) {
      res.status(400).json({ error: 'این سرویس هنوز به این شبکه خصوصی متصل نشده است.' });
      return;
    }

    const result = await probeTargetInNetwork({
      networkName: net.docker_name,
      containerName: `sokkan-${row.slug}`,
      port: row.container_port,
      method,
      reqPath,
      containerStatusHint: row.status,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در ارسال درخواست تست شبکه',
    });
  }
});

// Protected System Status & Telemetry
app.get('/api/system/status', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.authUser!;
    const [dockerUp, gitUp, caddyStatus, hostMetrics, beszel] = await Promise.all([
      isDockerAvailable(),
      isGitAvailable(),
      isCaddyAvailable(),
      getSystemHostMetrics(),
      fetchBeszelTelemetry(),
    ]);

    const recentSamples = db
      .prepare('SELECT cpu_percent, mem_percent, disk_percent, sampled_at FROM metric_samples ORDER BY id DESC LIMIT 30')
      .all()
      .reverse();

    const projectCount =
      user.role === 'admin'
        ? (db.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number }).c
        : (db.prepare('SELECT COUNT(*) as c FROM projects WHERE owner_user_id = ?').get(user.id) as { c: number }).c;

    const serviceCount =
      user.role === 'admin'
        ? (db.prepare('SELECT COUNT(*) as c FROM services').get() as { c: number }).c
        : (db.prepare('SELECT COUNT(*) as c FROM services WHERE owner_user_id = ?').get(user.id) as { c: number }).c;

    const networkCount =
      user.role === 'admin'
        ? (db.prepare('SELECT COUNT(*) as c FROM private_networks').get() as { c: number }).c
        : (db.prepare('SELECT COUNT(*) as c FROM private_networks WHERE owner_user_id = ?').get(user.id) as { c: number }).c;

    const deploymentCount =
      user.role === 'admin'
        ? (db.prepare('SELECT COUNT(*) as c FROM deployments').get() as { c: number }).c
        : (db
            .prepare(
              'SELECT COUNT(*) as c FROM deployments d INNER JOIN projects p ON d.project_id = p.id WHERE p.owner_user_id = ?',
            )
            .get(user.id) as { c: number }).c;

    res.json({
      executionMode: dockerUp && gitUp ? 'vps' : 'sandbox',
      appVersion: getLocalVersionInfo(),
      capabilities: {
        dockerAvailable: dockerUp,
        gitAvailable: gitUp,
        caddyReachable: caddyStatus.reachable,
        caddyMode: caddyStatus.mode,
      },
      counts: {
        projects: projectCount,
        services: serviceCount,
        networks: networkCount,
        deployments: deploymentCount,
      },
      hostMetrics,
      recentSamples,
      beszel: user.role === 'admin' ? beszel : { connected: false, systems: [], history: [] },
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'خطا در خواندن وضعیت سرور',
    });
  }
});

// Check for Sokkan updates against GitHub repository
app.post('/api/system/check-update', requireAuth, async (_req: AuthenticatedRequest, res) => {
  try {
    const result = await checkForUpdates();
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'خطا در بررسی نسخه جدید سکان',
    });
  }
});

// GitHub Repository Inspector
app.post('/api/github/inspect', requireAuth, async (req, res) => {
  try {
    const repoUrl = typeof req.body?.repoUrl === 'string' ? req.body.repoUrl : '';
    const branch = typeof req.body?.branch === 'string' ? req.body.branch : undefined;
    const token = typeof req.body?.githubToken === 'string' ? req.body.githubToken : undefined;
    const result = await inspectGitHubRepo(repoUrl, branch, token);
    res.json(result);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در بررسی مخزن گیتهاب',
    });
  }
});

// Projects CRUD & CI/CD (User-Scoped)
app.get('/api/projects', requireAuth, (req: AuthenticatedRequest, res) => {
  const user = req.authUser!;
  const rows =
    user.role === 'admin'
      ? (db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[])
      : (db
          .prepare('SELECT * FROM projects WHERE owner_user_id = ? ORDER BY created_at DESC')
          .all(user.id) as ProjectRow[]);
  res.json(rows.map(serializeProject));
});

app.post('/api/projects', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.authUser!;
    const body = req.body ?? {};
    const { canonicalUrl, repo } = parseGitHubRepoUrl(String(body.repoUrl || ''));
    const name = String(body.name || '').trim() || repo;
    const rawSlug = String(body.slug || repo)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!name || !rawSlug || !/^[a-z0-9-]+$/.test(rawSlug)) {
      res.status(400).json({ error: 'نام پروژه و شناسه انگلیسی معتبر (حروف کوچک و خط تیره) الزامی است.' });
      return;
    }

    const svcSlugConflict = db.prepare('SELECT id FROM services WHERE slug = ?').get(rawSlug);
    if (svcSlugConflict) {
      res.status(409).json({
        error: `شناسه «${rawSlug}» قبلاً توسط یک سرویس آماده استفاده شده است. لطفاً شناسه دیگری انتخاب کنید.`,
      });
      return;
    }

    const branch = validateBranchName(String(body.branch || 'main'));
    const buildMode = body.buildMode === 'compose' ? 'compose' : 'dockerfile';
    const deployStrategy = body.deployStrategy === 'github_actions' ? 'github_actions' : 'local';
    const ghcrImage = typeof body.ghcrImage === 'string' ? body.ghcrImage.trim() : '';
    if (ghcrImage && (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(ghcrImage) || ghcrImage.includes('..'))) {
      res.status(400).json({ error: 'فرمت آدرس ایمیج GHCR نامعتبر است.' });
      return;
    }
    const actionsComposeFile =
      typeof body.actionsComposeFile === 'string' ? body.actionsComposeFile.trim() : '';
    const buildFilePath = String(body.buildFilePath || (buildMode === 'compose' ? 'docker-compose.yml' : 'Dockerfile')).trim();
    const dockerfileContext = String(body.dockerfileContext || '.').trim();
    const containerPort = Number(body.containerPort || 3000);
    if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
      res.status(400).json({ error: 'شماره پورت کانتینر باید بین ۱ تا ۶۵۵۳۵ باشد.' });
      return;
    }

    const domain = String(body.domain || '').trim().toLowerCase();
    const caddyEnabled = body.caddyEnabled !== false;
    if (domain && !validateDomainString(domain)) {
      res.status(400).json({ error: 'فرمت دامنه وارد شده برای Caddy معتبر نیست.' });
      return;
    }
    if (domain && caddyEnabled) {
      const conflictOwner = findDomainConflict(domain);
      if (conflictOwner) {
        res.status(409).json({
          error: `دامنه «${domain}» قبلاً به ${conflictOwner} متصل شده است.`,
        });
        return;
      }
    }

    const privateNet = validatePrivateNetworkAssignment(
      user,
      typeof body.privateNetworkId === 'string' ? body.privateNetworkId : null,
    );

    const requestedExtraDirectives = String(body.caddyExtraDirectives || '');
    if (requestedExtraDirectives.trim() && user.role !== 'admin') {
      res.status(403).json({
        error: 'تنها مدیر کل سیستم می‌تواند دستورالعمل‌های سفارشی Caddyfile را تنظیم کند.',
      });
      return;
    }
    const caddyExtraDirectives = user.role === 'admin' ? requestedExtraDirectives : '';
    const autoDeployWebhook = body.autoDeployWebhook !== false;
    const pollingIntervalSec = Math.max(0, Math.min(86400, Number(body.pollingIntervalSec ?? 300)));
    const githubToken = typeof body.githubToken === 'string' ? body.githubToken.trim() : '';
    const webhookSecretInput =
      typeof body.webhookSecret === 'string' && body.webhookSecret.trim()
        ? body.webhookSecret.trim()
        : generateRandomHex(20);

    const envVarsObj =
      body.envVars && typeof body.envVars === 'object' ? (body.envVars as Record<string, string>) : {};
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(envVarsObj)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        cleanEnv[k] = String(v ?? '');
      }
    }

    const id = `prj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO projects (
        id, name, slug, repo_url, branch, build_mode, deploy_strategy, ghcr_image, actions_compose_file,
        build_file_path, dockerfile_context,
        container_port, domain, caddy_enabled, caddy_extra_directives, auto_deploy_webhook,
        polling_interval_sec, github_token_enc, webhook_secret_enc, env_vars_enc,
        last_commit_sha, last_commit_msg, status, owner_user_id, private_network_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      rawSlug,
      canonicalUrl,
      branch,
      buildMode,
      deployStrategy,
      ghcrImage,
      actionsComposeFile,
      buildFilePath,
      dockerfileContext,
      containerPort,
      domain,
      caddyEnabled ? 1 : 0,
      caddyExtraDirectives,
      autoDeployWebhook ? 1 : 0,
      pollingIntervalSec,
      encryptSecret(githubToken),
      encryptSecret(webhookSecretInput),
      encryptSecret(JSON.stringify(cleanEnv)),
      String(body.lastCommitSha || ''),
      String(body.lastCommitMsg || ''),
      user.id,
      privateNet?.id ?? null,
      now,
      now,
    );

    if (privateNet) {
      syncPrimaryNetworkAttachment('project', id, rawSlug, privateNet.id, null);
    }

    let caddyWarning: string | undefined;
    if (caddyEnabled && domain) {
      try {
        await syncProjectsToCaddyfile(`افزودن مسیر پروژه ${rawSlug}`);
      } catch (caddyErr) {
        caddyWarning =
          caddyErr instanceof Error ? caddyErr.message : 'همگام‌سازی خودکار Caddy با خطا مواجه شد.';
      }
    }

    const created = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow;
    res.status(201).json({
      project: serializeProject(created),
      generatedWebhookSecret: webhookSecretInput,
      caddyWarning,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'خطا در ایجاد پروژه';
    res.status(400).json({ error: msg.includes('UNIQUE') ? 'این شناسه پروژه قبلاً ثبت شده است.' : msg });
  }
});

app.patch('/api/projects/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.authUser!;
    const id = String(req.params.id || '');
    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!existing) {
      res.status(404).json({ error: 'پروژه پیدا نشد.' });
      return;
    }
    if (!canAccessResource(user, existing.owner_user_id)) {
      res.status(403).json({ error: 'شما مجوز ویرایش این پروژه را ندارید.' });
      return;
    }

    const body = req.body ?? {};
    const name = body.name !== undefined ? String(body.name).trim() : existing.name;
    const branch = body.branch !== undefined ? validateBranchName(String(body.branch)) : existing.branch;
    const buildMode =
      body.buildMode === 'compose' || body.buildMode === 'dockerfile'
        ? body.buildMode
        : existing.build_mode;
    const deployStrategy =
      body.deployStrategy === 'github_actions' || body.deployStrategy === 'local'
        ? body.deployStrategy
        : existing.deploy_strategy || 'local';
    const ghcrImage =
      body.ghcrImage !== undefined ? String(body.ghcrImage).trim() : existing.ghcr_image || '';
    if (ghcrImage && (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(ghcrImage) || ghcrImage.includes('..'))) {
      res.status(400).json({ error: 'فرمت آدرس ایمیج GHCR نامعتبر است.' });
      return;
    }
    const actionsComposeFile =
      body.actionsComposeFile !== undefined
        ? String(body.actionsComposeFile).trim()
        : existing.actions_compose_file || '';
    const buildFilePath =
      body.buildFilePath !== undefined ? String(body.buildFilePath).trim() : existing.build_file_path;
    const containerPort =
      body.containerPort !== undefined ? Number(body.containerPort) : existing.container_port;
    if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
      res.status(400).json({ error: 'پورت نامعتبر است.' });
      return;
    }
    const domain = body.domain !== undefined ? String(body.domain).trim().toLowerCase() : existing.domain;
    if (domain && !validateDomainString(domain)) {
      res.status(400).json({ error: 'فرمت دامنه نامعتبر است.' });
      return;
    }
    const caddyEnabled =
      body.caddyEnabled !== undefined ? (body.caddyEnabled ? 1 : 0) : existing.caddy_enabled;
    if (domain && caddyEnabled === 1) {
      const conflictOwner = findDomainConflict(domain, { projectId: id });
      if (conflictOwner) {
        res.status(409).json({
          error: `دامنه «${domain}» قبلاً به ${conflictOwner} متصل شده است.`,
        });
        return;
      }
    }

    let nextPrivateNetworkId = existing.private_network_id;
    if (body.privateNetworkId !== undefined) {
      const assigned = validatePrivateNetworkAssignment(
        user,
        typeof body.privateNetworkId === 'string' ? body.privateNetworkId : null,
      );
      nextPrivateNetworkId = assigned?.id ?? null;
    }

    let caddyExtraDirectives = existing.caddy_extra_directives;
    if (body.caddyExtraDirectives !== undefined) {
      const requested = String(body.caddyExtraDirectives);
      if (user.role !== 'admin' && requested !== existing.caddy_extra_directives) {
        res.status(403).json({
          error: 'تنها مدیر کل سیستم می‌تواند دستورالعمل‌های سفارشی Caddyfile را تغییر دهد.',
        });
        return;
      }
      if (user.role === 'admin') {
        caddyExtraDirectives = requested;
      }
    }
    const autoDeployWebhook =
      body.autoDeployWebhook !== undefined
        ? body.autoDeployWebhook
          ? 1
          : 0
        : existing.auto_deploy_webhook;
    const pollingIntervalSec =
      body.pollingIntervalSec !== undefined
        ? Math.max(0, Math.min(86400, Number(body.pollingIntervalSec)))
        : existing.polling_interval_sec;

    const githubTokenEnc =
      typeof body.githubToken === 'string' && body.githubToken.trim()
        ? encryptSecret(body.githubToken.trim())
        : existing.github_token_enc;

    const webhookSecretEnc =
      typeof body.webhookSecret === 'string' && body.webhookSecret.trim()
        ? encryptSecret(body.webhookSecret.trim())
        : existing.webhook_secret_enc;

    let envVarsEnc = existing.env_vars_enc;
    if (body.envVars && typeof body.envVars === 'object') {
      const currentEnv = JSON.parse(decryptSecret(existing.env_vars_enc) || '{}') as Record<
        string,
        string
      >;
      for (const [k, v] of Object.entries(body.envVars as Record<string, string | null>)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
        if (v === null) {
          delete currentEnv[k];
        } else {
          currentEnv[k] = String(v);
        }
      }
      envVarsEnc = encryptSecret(JSON.stringify(currentEnv));
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE projects SET
        name = ?, branch = ?, build_mode = ?, deploy_strategy = ?, ghcr_image = ?, actions_compose_file = ?,
        build_file_path = ?, container_port = ?,
        domain = ?, caddy_enabled = ?, caddy_extra_directives = ?, auto_deploy_webhook = ?,
        polling_interval_sec = ?, github_token_enc = ?, webhook_secret_enc = ?, env_vars_enc = ?,
        private_network_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      name,
      branch,
      buildMode,
      deployStrategy,
      ghcrImage,
      actionsComposeFile,
      buildFilePath,
      containerPort,
      domain,
      caddyEnabled,
      caddyExtraDirectives,
      autoDeployWebhook,
      pollingIntervalSec,
      githubTokenEnc,
      webhookSecretEnc,
      envVarsEnc,
      nextPrivateNetworkId,
      now,
      id,
    );

    if (body.privateNetworkId !== undefined && nextPrivateNetworkId !== existing.private_network_id) {
      syncPrimaryNetworkAttachment(
        'project',
        id,
        existing.slug,
        nextPrivateNetworkId,
        existing.private_network_id,
      );
      const dockerUp = await isDockerAvailable();
      if (dockerUp) {
        if (existing.private_network_id) {
          const oldNet = db
            .prepare('SELECT docker_name FROM private_networks WHERE id = ?')
            .get(existing.private_network_id) as { docker_name: string } | undefined;
          if (oldNet) {
            await disconnectContainerFromNetwork(`sokkan-${existing.slug}`, oldNet.docker_name);
          }
        }
        if (nextPrivateNetworkId) {
          const newNet = db
            .prepare('SELECT * FROM private_networks WHERE id = ?')
            .get(nextPrivateNetworkId) as PrivateNetworkRow | undefined;
          if (newNet) {
            await ensureDockerNetwork(newNet.docker_name, {
              internal: newNet.internal_only === 1,
              subnet: newNet.subnet || undefined,
              ownerUserId: newNet.owner_user_id,
            });
            await connectContainerToNetwork(`sokkan-${existing.slug}`, newNet.docker_name, [
              existing.slug,
            ]);
          }
        }
      }
    }

    let caddyWarning: string | undefined;
    try {
      await syncProjectsToCaddyfile(`به‌روزرسانی تنظیمات پروژه ${existing.slug}`);
    } catch (caddyErr) {
      caddyWarning =
        caddyErr instanceof Error ? caddyErr.message : 'همگام‌سازی خودکار Caddy با خطا مواجه شد.';
    }
    const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow;
    res.json({ ...serializeProject(updated), caddyWarning });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در ویرایش پروژه',
    });
  }
});

app.delete('/api/projects/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id || '');
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'پروژه پیدا نشد.' });
    return;
  }
  if (!canAccessResource(req.authUser!, existing.owner_user_id)) {
    res.status(403).json({ error: 'شما مجوز حذف این پروژه را ندارید.' });
    return;
  }

  // Stop & remove running container and clean up confined workspace on VPS
  const dockerUp = await isDockerAvailable();
  if (dockerUp) {
    await performContainerAction(`sokkan-${existing.slug}`, 'remove').catch(() => {});
  }
  cleanupProjectWorkspace(existing.slug);

  db.prepare("DELETE FROM network_attachments WHERE resource_type = 'project' AND resource_id = ?").run(id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  await syncProjectsToCaddyfile(`حذف مسیر پروژه ${existing.slug}`).catch(() => {});
  res.json({ ok: true });
});

app.post('/api/projects/:id/rotate-webhook', requireAuth, (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id || '');
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'پروژه پیدا نشد.' });
    return;
  }
  if (!canAccessResource(req.authUser!, existing.owner_user_id)) {
    res.status(403).json({ error: 'شما مجوز تغییر کلید وب‌هوک این پروژه را ندارید.' });
    return;
  }
  const newSecret = generateRandomHex(20);
  db.prepare('UPDATE projects SET webhook_secret_enc = ?, updated_at = ? WHERE id = ?').run(
    encryptSecret(newSecret),
    new Date().toISOString(),
    id,
  );
  res.json({ webhookSecret: newSecret });
});

app.post('/api/projects/:id/deploy', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = String(req.params.id || '');
    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!existing) {
      res.status(404).json({ error: 'پروژه پیدا نشد.' });
      return;
    }
    if (!canAccessResource(req.authUser!, existing.owner_user_id)) {
      res.status(403).json({ error: 'شما مجوز اجرای دیپلوی برای این پروژه را ندارید.' });
      return;
    }
    const dep = await triggerDeployment(id, 'manual');
    res.status(202).json(dep);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در شروع دیپلوی',
    });
  }
});

// Deployments & Streaming Logs (User-Scoped)
app.get('/api/deployments', requireAuth, (req: AuthenticatedRequest, res) => {
  const user = req.authUser!;
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : null;
  if (projectId) {
    const proj = db.prepare('SELECT owner_user_id FROM projects WHERE id = ?').get(projectId) as
      | { owner_user_id: string }
      | undefined;
    if (!proj || !canAccessResource(user, proj.owner_user_id)) {
      res.json([]);
      return;
    }
    const rows = db
      .prepare('SELECT * FROM deployments WHERE project_id = ? ORDER BY started_at DESC LIMIT 40')
      .all(projectId) as DeploymentRow[];
    res.json(rows);
    return;
  }

  const rows =
    user.role === 'admin'
      ? (db.prepare('SELECT * FROM deployments ORDER BY started_at DESC LIMIT 40').all() as DeploymentRow[])
      : (db
          .prepare(
            `SELECT d.* FROM deployments d
             INNER JOIN projects p ON d.project_id = p.id
             WHERE p.owner_user_id = ?
             ORDER BY d.started_at DESC LIMIT 40`,
          )
          .all(user.id) as DeploymentRow[]);
  res.json(rows);
});

app.get('/api/deployments/:id', requireAuth, (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id || '');
  const row = db.prepare('SELECT * FROM deployments WHERE id = ?').get(id) as
    | DeploymentRow
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'رکورد دیپلوی پیدا نشد.' });
    return;
  }
  const proj = db.prepare('SELECT owner_user_id FROM projects WHERE id = ?').get(row.project_id) as
    | { owner_user_id: string }
    | undefined;
  if (!proj || !canAccessResource(req.authUser!, proj.owner_user_id)) {
    res.status(403).json({ error: 'شما مجوز مشاهده این لاگ دیپلوی را ندارید.' });
    return;
  }
  res.json(row);
});

app.get('/api/deployments/:id/stream', requireAuth, (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id || '');
  const row = db.prepare('SELECT * FROM deployments WHERE id = ?').get(id) as
    | DeploymentRow
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'رکورد دیپلوی پیدا نشد.' });
    return;
  }
  const proj = db.prepare('SELECT owner_user_id FROM projects WHERE id = ?').get(row.project_id) as
    | { owner_user_id: string }
    | undefined;
  if (!proj || !canAccessResource(req.authUser!, proj.owner_user_id)) {
    res.status(403).json({ error: 'شما مجوز مشاهده این لاگ دیپلوی را ندارید.' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (row.logs) {
    res.write(`event: init\ndata: ${JSON.stringify({ logs: row.logs, status: row.status })}\n\n`);
  }

  if (row.status === 'success' || row.status === 'failed') {
    res.write(`event: done\ndata: ${JSON.stringify({ status: row.status })}\n\n`);
    res.end();
    return;
  }

  const onLog = (chunk: string) => {
    res.write(`event: log\ndata: ${JSON.stringify({ chunk })}\n\n`);
  };
  const onDone = (status: string) => {
    res.write(`event: done\ndata: ${JSON.stringify({ status })}\n\n`);
    cleanup();
    res.end();
  };
  const cleanup = () => {
    deployLogBus.off(`log:${id}`, onLog);
    deployLogBus.off(`done:${id}`, onDone);
  };

  deployLogBus.on(`log:${id}`, onLog);
  deployLogBus.on(`done:${id}`, onDone);
  req.on('close', cleanup);
});

// Docker Containers Control (Admin sees all; Member sees only own containers)
app.get('/api/containers', requireAuth, async (req: AuthenticatedRequest, res) => {
  const dockerUp = await isDockerAvailable();
  if (!dockerUp) {
    res.json({ dockerAvailable: false, containers: [] });
    return;
  }
  try {
    const user = req.authUser!;
    const allContainers = await listDockerContainers();
    const containers =
      user.role === 'admin'
        ? allContainers
        : allContainers.filter((c) => canAccessContainer(user, c.name, c.ownerUserId));
    res.json({ dockerAvailable: true, containers });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'خطا در ارتباط با داکر',
    });
  }
});

async function assertContainerAccess(user: AuthUser, containerId: string): Promise<boolean> {
  if (user.role === 'admin') return true;
  const all = await listDockerContainers();
  const target = all.find((c) => c.id === containerId || c.shortId === containerId || c.name === containerId);
  if (!target) return false;
  return canAccessContainer(user, target.name, target.ownerUserId);
}

app.post('/api/containers/:id/:action', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = String(req.params.id || '');
    const action = String(req.params.action || '');
    if (!['start', 'stop', 'restart', 'remove'].includes(action)) {
      res.status(400).json({ error: 'عملیات نامعتبر است.' });
      return;
    }
    const allowed = await assertContainerAccess(req.authUser!, id);
    if (!allowed) {
      res.status(403).json({ error: 'شما مجوز کنترل این کانتینر را ندارید.' });
      return;
    }
    await performContainerAction(id, action as 'start' | 'stop' | 'restart' | 'remove');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در اجرای دستور داکر',
    });
  }
});

app.get('/api/containers/:id/logs', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = String(req.params.id || '');
    const allowed = await assertContainerAccess(req.authUser!, id);
    if (!allowed) {
      res.status(403).json({ error: 'شما مجوز مشاهده لاگ این کانتینر را ندارید.' });
      return;
    }
    const tail = Number(req.query.tail || 200);
    const logs = await getContainerLogs(id, tail);
    res.json({ logs });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در خواندن لاگ کانتینر',
    });
  }
});

app.get('/api/containers/:id/stats', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = String(req.params.id || '');
    const allowed = await assertContainerAccess(req.authUser!, id);
    if (!allowed) {
      res.status(403).json({ error: 'شما مجوز مشاهده آمار این کانتینر را ندارید.' });
      return;
    }
    const stats = await getContainerStats(id);
    res.json(stats);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در دریافت آمار مصرف منابع کانتینر',
    });
  }
});

app.get('/api/docker/disk-usage', requireAuth, requireAdmin, async (_req, res) => {
  const dockerUp = await isDockerAvailable();
  if (!dockerUp) {
    res.json({ dockerAvailable: false, categories: [] });
    return;
  }
  const categories = await getDockerDiskUsage();
  res.json({ dockerAvailable: true, categories });
});

app.post('/api/docker/prune', requireAuth, requireAdmin, async (_req, res) => {
  const dockerUp = await isDockerAvailable();
  if (!dockerUp) {
    res.status(400).json({ error: 'سوکت داکر در این محیط متصل نیست.' });
    return;
  }
  try {
    const result = await pruneDockerUnused();
    const categories = await getDockerDiskUsage();
    res.json({ ok: true, ...result, categories });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'خطا در پاک‌سازی فضای داکر',
    });
  }
});

// One-Click Ready Apps & Databases (User-Scoped)
app.get('/api/templates', requireAuth, (_req, res) => {
  res.json(SERVICE_TEMPLATES);
});

app.get('/api/services', requireAuth, (req: AuthenticatedRequest, res) => {
  const user = req.authUser!;
  const rows =
    user.role === 'admin'
      ? (db.prepare('SELECT * FROM services ORDER BY created_at DESC').all() as ServiceRow[])
      : (db
          .prepare('SELECT * FROM services WHERE owner_user_id = ? ORDER BY created_at DESC')
          .all(user.id) as ServiceRow[]);
  res.json(rows.map(serializeService));
});

app.post('/api/services', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.authUser!;
    const body = req.body ?? {};
    const templateId = String(body.templateId || '').trim();
    const template = findServiceTemplate(templateId);
    if (!template) {
      res.status(400).json({ error: 'قالب سرویس انتخاب‌شده نامعتبر است.' });
      return;
    }

    const rawSlug = String(body.slug || template.defaultSlug)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!rawSlug || !/^[a-z0-9-]+$/.test(rawSlug)) {
      res.status(400).json({ error: 'شناسه کانتینر (انگلیسی با حروف کوچک و خط تیره) الزامی است.' });
      return;
    }

    const slugUsedInProjects = db.prepare('SELECT id FROM projects WHERE slug = ?').get(rawSlug);
    if (slugUsedInProjects) {
      res.status(409).json({ error: `شناسه «${rawSlug}» قبلاً در پروژه‌ها استفاده شده است.` });
      return;
    }

    const name = String(body.name || '').trim() || template.name;
    const domain = template.supportsDomain ? String(body.domain || '').trim().toLowerCase() : '';
    const caddyEnabled = template.supportsDomain && domain.length > 0 && body.caddyEnabled !== false;
    if (domain && !validateDomainString(domain)) {
      res.status(400).json({ error: 'فرمت دامنه وارد شده معتبر نیست.' });
      return;
    }
    if (domain && caddyEnabled) {
      const conflictOwner = findDomainConflict(domain);
      if (conflictOwner) {
        res.status(409).json({
          error: `دامنه «${domain}» قبلاً به ${conflictOwner} متصل شده است.`,
        });
        return;
      }
    }

    const privateNet = validatePrivateNetworkAssignment(
      user,
      typeof body.privateNetworkId === 'string' ? body.privateNetworkId : null,
    );

    const memLimitMb = Math.max(
      64,
      Math.min(2048, Number(body.memLimitMb || template.defaultMemLimitMb)),
    );
    const inputEnv =
      body.envVars && typeof body.envVars === 'object' ? (body.envVars as Record<string, string>) : {};
    const finalEnv = buildServiceEnvWithDefaults(template, inputEnv, domain);
    const resolvedCmd = resolveCommandTemplate(template.commandTemplate, finalEnv);

    const id = `svc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO services (
        id, template_id, name, slug, image, category, container_port, domain,
        caddy_enabled, mem_limit_mb, env_vars_enc, volumes_json, command_json,
        status, last_message, owner_user_id, private_network_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'deploying', '', ?, ?, ?, ?)`,
    ).run(
      id,
      template.id,
      name,
      rawSlug,
      template.image,
      template.category,
      template.containerPort,
      domain,
      caddyEnabled ? 1 : 0,
      memLimitMb,
      encryptSecret(JSON.stringify(finalEnv)),
      JSON.stringify(template.volumes),
      JSON.stringify(resolvedCmd),
      user.id,
      privateNet?.id ?? null,
      now,
      now,
    );

    if (privateNet) {
      syncPrimaryNetworkAttachment('service', id, rawSlug, privateNet.id, null);
    }

    const inserted = db.prepare('SELECT * FROM services WHERE id = ?').get(id) as ServiceRow;
    const deployResult = await deployServiceInstance(inserted);

    db.prepare('UPDATE services SET status = ?, last_message = ?, updated_at = ? WHERE id = ?').run(
      deployResult.status,
      deployResult.message,
      new Date().toISOString(),
      id,
    );

    if (caddyEnabled && domain && deployResult.status === 'running') {
      await syncProjectsToCaddyfile(`افزودن مسیر سرویس آماده ${rawSlug}`).catch((err) => {
        const msg = err instanceof Error ? err.message : 'خطا در همگام‌سازی Caddy';
        db.prepare('UPDATE services SET last_message = ? WHERE id = ?').run(
          `${deployResult.message} (هشدار Caddy: ${msg})`,
          id,
        );
      });
    }

    const finalRow = db.prepare('SELECT * FROM services WHERE id = ?').get(id) as ServiceRow;
    res.status(201).json({
      service: serializeService(finalRow),
      generatedEnv: finalEnv,
      executionMode: deployResult.executionMode,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'خطا در راه‌اندازی سرویس آماده';
    res.status(400).json({ error: msg.includes('UNIQUE') ? 'این شناسه سرویس قبلاً ثبت شده است.' : msg });
  }
});

app.post('/api/services/:id/redeploy', requireAuth, async (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id || '');
  const row = db.prepare('SELECT * FROM services WHERE id = ?').get(id) as ServiceRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'سرویس پیدا نشد.' });
    return;
  }
  if (!canAccessResource(req.authUser!, row.owner_user_id)) {
    res.status(403).json({ error: 'شما مجوز کنترل این سرویس را ندارید.' });
    return;
  }
  const deployResult = await deployServiceInstance(row);
  db.prepare('UPDATE services SET status = ?, last_message = ?, updated_at = ? WHERE id = ?').run(
    deployResult.status,
    deployResult.message,
    new Date().toISOString(),
    id,
  );
  if (row.caddy_enabled === 1 && row.domain) {
    await syncProjectsToCaddyfile(`به‌روزرسانی سرویس آماده ${row.slug}`).catch(() => {});
  }
  const updated = db.prepare('SELECT * FROM services WHERE id = ?').get(id) as ServiceRow;
  res.json({ service: serializeService(updated), executionMode: deployResult.executionMode });
});

app.post('/api/services/:id/:action', requireAuth, async (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id || '');
  const action = String(req.params.action || '');
  if (!['start', 'stop', 'restart'].includes(action)) {
    res.status(400).json({ error: 'عملیات نامعتبر است.' });
    return;
  }
  const row = db.prepare('SELECT * FROM services WHERE id = ?').get(id) as ServiceRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'سرویس پیدا نشد.' });
    return;
  }
  if (!canAccessResource(req.authUser!, row.owner_user_id)) {
    res.status(403).json({ error: 'شما مجوز کنترل این سرویس را ندارید.' });
    return;
  }
  try {
    const dockerUp = await isDockerAvailable();
    if (dockerUp) {
      await performContainerAction(`sokkan-${row.slug}`, action as 'start' | 'stop' | 'restart');
    }
    const nextStatus = action === 'stop' ? 'stopped' : 'running';
    db.prepare('UPDATE services SET status = ?, updated_at = ? WHERE id = ?').run(
      nextStatus,
      new Date().toISOString(),
      id,
    );
    const updated = db.prepare('SELECT * FROM services WHERE id = ?').get(id) as ServiceRow;
    res.json({ ok: true, service: serializeService(updated) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'اجرای عملیات ناموفق بود.' });
  }
});

app.delete('/api/services/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id || '');
  const row = db.prepare('SELECT * FROM services WHERE id = ?').get(id) as ServiceRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'سرویس پیدا نشد.' });
    return;
  }
  if (!canAccessResource(req.authUser!, row.owner_user_id)) {
    res.status(403).json({ error: 'شما مجوز حذف این سرویس را ندارید.' });
    return;
  }
  await removeServiceContainer(row.slug);
  db.prepare("DELETE FROM network_attachments WHERE resource_type = 'service' AND resource_id = ?").run(id);
  db.prepare('DELETE FROM services WHERE id = ?').run(id);
  if (row.caddy_enabled === 1 && row.domain) {
    await syncProjectsToCaddyfile(`حذف مسیر سرویس آماده ${row.slug}`).catch(() => {});
  }
  res.json({ ok: true });
});

// Caddyfile Global & Managed Routes (Admin Only for Global Caddyfile Management)
app.get('/api/caddy', requireAuth, requireAdmin, async (_req, res) => {
  const content = getSetting('caddyfile_content') ?? DEFAULT_CADDYFILE;
  const projects = db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all() as ProjectRow[];
  const services = db.prepare('SELECT * FROM services ORDER BY created_at ASC').all() as ServiceRow[];
  const managedPreview = renderManagedRoutesBlock(projects, services);
  const snapshots = listCaddySnapshots(20);
  const caddyStatus = await isCaddyAvailable();

  res.json({
    content,
    managedPreview,
    snapshots,
    caddyStatus,
    routes: [
      ...projects.map((p) => ({
        projectId: p.id,
        sourceType: 'project' as const,
        name: p.name,
        slug: p.slug,
        domain: p.domain,
        upstream: `sokkan-${p.slug}:${p.container_port}`,
        containerPort: p.container_port,
        caddyEnabled: p.caddy_enabled === 1,
        caddyExtraDirectives: p.caddy_extra_directives,
      })),
      ...services
        .filter((s) => s.domain.trim().length > 0)
        .map((s) => ({
          projectId: s.id,
          sourceType: 'service' as const,
          name: `${s.name} (سرویس آماده)`,
          slug: s.slug,
          domain: s.domain,
          upstream: `sokkan-${s.slug}:${s.container_port}`,
          containerPort: s.container_port,
          caddyEnabled: s.caddy_enabled === 1,
          caddyExtraDirectives: '',
        })),
    ],
  });
});

app.post('/api/caddy/validate', requireAuth, requireAdmin, async (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const result = await validateCaddyfile(content);
  res.json(result);
});

app.post('/api/caddy/apply', requireAuth, requireAdmin, async (req, res) => {
  try {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim() : 'ویرایش دستی Caddyfile';
    const result = await applyCaddyfile(content, note);
    res.json(result);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در اعمال تنظیمات Caddyfile',
    });
  }
});

app.post('/api/caddy/sync-routes', requireAuth, requireAdmin, async (_req, res) => {
  try {
    await syncProjectsToCaddyfile('همگام‌سازی خودکار مسیرهای پروژه');
    res.json({ ok: true, content: getSetting('caddyfile_content') ?? DEFAULT_CADDYFILE });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در همگام‌سازی مسیرهای Caddy',
    });
  }
});

app.post('/api/caddy/rollback/:snapshotId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const snapshotId = String(req.params.snapshotId || '');
    const snap = db
      .prepare('SELECT * FROM caddy_snapshots WHERE id = ?')
      .get(snapshotId) as { id: string; content: string; note: string } | undefined;
    if (!snap) {
      res.status(404).json({ error: 'نسخه اسنپ‌شات پیدا نشد.' });
      return;
    }
    const result = await applyCaddyfile(snap.content, `بازگشت به نسخه قبلی (${snap.note})`);
    res.json(result);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در بازگشت به نسخه قبلی',
    });
  }
});

// Beszel Optional Integration (Admin Only)
app.get('/api/integrations/beszel', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (req.authUser!.role !== 'admin') {
    res.json({
      config: { enabled: false, url: '', email: '', hasPassword: false },
      telemetry: { connected: false, systems: [], history: [] },
    });
    return;
  }
  const config = getBeszelConfigPublic();
  const telemetry = await fetchBeszelTelemetry();
  res.json({ config, telemetry });
});

app.post('/api/integrations/beszel', requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body ?? {};
    const config = saveBeszelConfig({
      enabled: Boolean(body.enabled),
      url: String(body.url || ''),
      email: String(body.email || ''),
      password: typeof body.password === 'string' ? body.password : undefined,
    });
    const telemetry = await fetchBeszelTelemetry();
    res.json({ config, telemetry });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در ذخیره تنظیمات Beszel',
    });
  }
});

// VPS Zero-to-One Provisioning & Backup/Restore (Admin Only)
app.post('/api/provisioning/generate', requireAuth, requireAdmin, (req, res) => {
  const body = req.body ?? {};
  const opts: BootstrapOptions = {
    panelDomain: String(body.panelDomain || 'panel.example.com'),
    caddyEmail: String(body.caddyEmail || 'admin@example.com'),
    dockerNetwork: String(body.dockerNetwork || 'web').replace(/[^a-zA-Z0-9_-]/g, '') || 'web',
    panelPort: Math.max(1024, Math.min(65535, Number(body.panelPort || 3000))),
    basicAuthUser: String(body.basicAuthUser || 'admin'),
    includeBeszel: Boolean(body.includeBeszel),
    configureUfw: body.configureUfw !== false,
    panelRepoOrImage: String(body.panelRepoOrImage || 'sokkan-panel:latest'),
  };
  res.json({
    bootstrapScript: generateBootstrapScript(opts),
    dockerComposeYaml: generatePanelComposeYaml(opts),
    dockerfile: generatePanelDockerfile(),
  });
});

function safeJsonObject(raw: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        out[k] = String(v ?? '');
      }
    }
    return out;
  } catch {
    return {};
  }
}

function safeJsonArray<T>(raw: string): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function buildFullBackupPayload(): Record<string, unknown> {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];
  const privateNetworks = db
    .prepare('SELECT * FROM private_networks ORDER BY created_at ASC')
    .all() as PrivateNetworkRow[];
  const networkAttachments = db
    .prepare('SELECT * FROM network_attachments ORDER BY created_at ASC')
    .all() as NetworkAttachmentRow[];
  const projects = db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all() as ProjectRow[];
  const services = db.prepare('SELECT * FROM services ORDER BY created_at ASC').all() as ServiceRow[];
  const caddyfile = getSetting('caddyfile_content') ?? DEFAULT_CADDYFILE;
  const caddySnapshots = db
    .prepare('SELECT * FROM caddy_snapshots ORDER BY created_at DESC LIMIT 20')
    .all() as CaddySnapshotRow[];
  const beszel = getBeszelConfigForBackup();

  return {
    schemaVersion: 2,
    app: 'sokkan',
    exportedAt: new Date().toISOString(),
    includesSecrets: true,
    securityNote:
      'این فایل پشتیبان کامل شامل تمام کاربران و هش رمز عبور، شبکه‌های خصوصی، توکن‌های گیتهاب، کلیدهای وب‌هوک، متغیرهای محیطی (.env)، رمز سرویس‌ها و دیتابیس‌ها، رمز Beszel و تنظیمات Caddyfile است. آن را در جای امن نگهداری کنید.',
    users: users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      role: u.role,
      passwordHash: u.password_hash,
      isActive: u.is_active === 1,
      createdAt: u.created_at,
      updatedAt: u.updated_at,
    })),
    privateNetworks: privateNetworks.map((n) => ({
      id: n.id,
      name: n.name,
      slug: n.slug,
      dockerName: n.docker_name,
      ownerUserId: n.owner_user_id,
      description: n.description,
      subnet: n.subnet,
      internalOnly: n.internal_only === 1,
      createdAt: n.created_at,
      updatedAt: n.updated_at,
    })),
    networkAttachments: networkAttachments.map((a) => ({
      id: a.id,
      networkId: a.network_id,
      resourceType: a.resource_type,
      resourceId: a.resource_id,
      alias: a.alias,
      createdAt: a.created_at,
    })),
    services: services.map((s) => ({
      id: s.id,
      templateId: s.template_id,
      name: s.name,
      slug: s.slug,
      image: s.image,
      category: s.category,
      containerPort: s.container_port,
      domain: s.domain,
      caddyEnabled: s.caddy_enabled === 1,
      memLimitMb: s.mem_limit_mb,
      envVars: safeJsonObject(decryptSecret(s.env_vars_enc)),
      volumes: safeJsonArray<{ name: string; mountPath: string }>(s.volumes_json),
      command: safeJsonArray<string>(s.command_json),
      status: s.status,
      lastMessage: s.last_message,
      ownerUserId: s.owner_user_id,
      privateNetworkId: s.private_network_id,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    })),
    projects: projects.map((p) => {
      const envVars = safeJsonObject(decryptSecret(p.env_vars_enc));
      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        repoUrl: p.repo_url,
        branch: p.branch,
        buildMode: p.build_mode,
        deployStrategy: p.deploy_strategy || 'local',
        ghcrImage: p.ghcr_image || '',
        actionsComposeFile: p.actions_compose_file || '',
        buildFilePath: p.build_file_path,
        dockerfileContext: p.dockerfile_context,
        containerPort: p.container_port,
        domain: p.domain,
        caddyEnabled: p.caddy_enabled === 1,
        caddyExtraDirectives: p.caddy_extra_directives,
        autoDeployWebhook: p.auto_deploy_webhook === 1,
        pollingIntervalSec: p.polling_interval_sec,
        githubToken: decryptSecret(p.github_token_enc),
        webhookSecret: decryptSecret(p.webhook_secret_enc),
        envVars,
        envKeys: Object.keys(envVars),
        lastCommitSha: p.last_commit_sha,
        lastCommitMsg: p.last_commit_msg,
        lastDeployedAt: p.last_deployed_at,
        ownerUserId: p.owner_user_id,
        privateNetworkId: p.private_network_id,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      };
    }),
    beszel: {
      enabled: beszel.enabled,
      url: beszel.url,
      email: beszel.email,
      password: beszel.password,
    },
    caddyfile,
    caddySnapshots: caddySnapshots.map((snap) => ({
      id: snap.id,
      content: snap.content,
      note: snap.note,
      applied: snap.applied === 1,
      createdAt: snap.created_at,
    })),
  };
}

app.get('/api/backup/export', requireAuth, requireAdmin, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(buildFullBackupPayload());
});

app.post('/api/backup/export', requireAuth, requireAdmin, (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const passphrase = typeof req.body?.passphrase === 'string' ? req.body.passphrase.trim() : '';
    const payload = buildFullBackupPayload();
    if (passphrase) {
      const envelope = encryptBackupPayload(payload, passphrase);
      res.json(envelope);
      return;
    }
    res.json(payload);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در تهیه فایل پشتیبان',
    });
  }
});

app.post('/api/backup/import', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res) => {
  try {
    const rawBody = req.body;
    if (!rawBody || typeof rawBody !== 'object') {
      res.status(400).json({ error: 'فرمت فایل پشتیبان معتبر نیست.' });
      return;
    }

    const isWrapped = 'backup' in rawBody && typeof rawBody.backup === 'object' && rawBody.backup !== null;
    const rawBackup = isWrapped ? (rawBody.backup as Record<string, unknown>) : (rawBody as Record<string, unknown>);
    const passphrase =
      isWrapped && typeof rawBody.passphrase === 'string' ? rawBody.passphrase : '';
    const requestedMode: 'replace' | 'merge' =
      isWrapped && rawBody.mode === 'merge'
        ? 'merge'
        : isWrapped && rawBody.mode === 'replace'
          ? 'replace'
          : rawBackup.schemaVersion === 1
            ? 'merge'
            : 'replace';
    const redeployServices = Boolean(isWrapped && rawBody.redeployServices === true);

    let data: Record<string, unknown>;
    if (isEncryptedBackupEnvelope(rawBackup)) {
      data = decryptBackupPayload(rawBackup, passphrase);
    } else {
      data = rawBackup;
    }

    const schemaVersion = Number(data.schemaVersion);
    if ((schemaVersion !== 1 && schemaVersion !== 2) || !Array.isArray(data.projects)) {
      res.status(400).json({ error: 'نسخه یا ساختار فایل پشتیبان پشتیبانی نمی‌شود.' });
      return;
    }

    const now = new Date().toISOString();
    const warnings: string[] = [];
    const counts = {
      users: 0,
      privateNetworks: 0,
      networkAttachments: 0,
      services: 0,
      projects: 0,
      caddySnapshots: 0,
      beszelRestored: false,
      caddyfileRestored: false,
      servicesRedeployed: 0,
    };

    // Capture current root admin before any replace so we can never lock out the panel
    const fallbackAdminRow = db
      .prepare("SELECT * FROM users WHERE id = 'usr_admin' OR username = 'admin'")
      .get() as UserRow | undefined;

    const cleanEnvMap = (input: unknown): Record<string, string> => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          out[k] = String(v ?? '');
        }
      }
      return out;
    };

    const runRestoreTx = db.transaction(() => {
      if (schemaVersion === 2 && requestedMode === 'replace') {
        db.prepare('DELETE FROM network_attachments').run();
        db.prepare('DELETE FROM deployments').run();
        db.prepare('DELETE FROM projects').run();
        db.prepare('DELETE FROM services').run();
        db.prepare('DELETE FROM private_networks').run();
        db.prepare('DELETE FROM caddy_snapshots').run();
        db.prepare('DELETE FROM users').run();
      }

      // 1. Restore Users (with password hashes, roles, and active status)
      const rawUsers = Array.isArray(data.users) ? (data.users as Array<Record<string, unknown>>) : [];
      let hasRootAdmin = false;
      for (const rawU of rawUsers) {
        const username = String(rawU.username || '').trim().toLowerCase();
        if (!/^[a-z0-9_.-]{3,32}$/.test(username)) continue;
        const id =
          typeof rawU.id === 'string' && rawU.id.trim()
            ? rawU.id.trim()
            : username === 'admin'
              ? 'usr_admin'
              : `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const displayName = String(rawU.displayName || username).trim() || username;
        const role: 'admin' | 'member' =
          id === 'usr_admin' || username === 'admin' || rawU.role === 'admin' ? 'admin' : 'member';
        const rawHash = typeof rawU.passwordHash === 'string' ? rawU.passwordHash.trim() : '';
        const passwordHash = rawHash.startsWith('scrypt$') ? rawHash : '';
        const isActive = id === 'usr_admin' || rawU.isActive !== false ? 1 : 0;
        const createdAt = typeof rawU.createdAt === 'string' && rawU.createdAt ? rawU.createdAt : now;
        const updatedAt = typeof rawU.updatedAt === 'string' && rawU.updatedAt ? rawU.updatedAt : now;

        const existingUser = db
          .prepare('SELECT id FROM users WHERE id = ? OR LOWER(username) = ?')
          .get(id, username) as { id: string } | undefined;

        if (existingUser) {
          if (requestedMode === 'replace') {
            db.prepare(
              `UPDATE users SET display_name = ?, role = ?, password_hash = ?, is_active = ?, updated_at = ?
               WHERE id = ?`,
            ).run(displayName, role, passwordHash, isActive, updatedAt, existingUser.id);
            counts.users += 1;
          }
        } else {
          db.prepare(
            `INSERT INTO users (id, username, display_name, role, password_hash, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(id, username, displayName, role, passwordHash, isActive, createdAt, updatedAt);
          counts.users += 1;
        }

        if (id === 'usr_admin' || username === 'admin') {
          hasRootAdmin = true;
          if (passwordHash) {
            setSetting('admin_password_hash', passwordHash);
          }
        }
      }

      if (!hasRootAdmin && fallbackAdminRow) {
        const existsNow = db.prepare("SELECT id FROM users WHERE id = 'usr_admin'").get();
        if (!existsNow) {
          db.prepare(
            `INSERT INTO users (id, username, display_name, role, password_hash, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            fallbackAdminRow.id,
            fallbackAdminRow.username,
            fallbackAdminRow.display_name,
            fallbackAdminRow.role,
            fallbackAdminRow.password_hash,
            fallbackAdminRow.is_active,
            fallbackAdminRow.created_at,
            fallbackAdminRow.updated_at,
          );
          if (fallbackAdminRow.password_hash) {
            setSetting('admin_password_hash', fallbackAdminRow.password_hash);
          }
        }
      }

      const validUserIds = new Set(
        (db.prepare('SELECT id FROM users').all() as Array<{ id: string }>).map((u) => u.id),
      );
      const resolveOwnerId = (candidate: unknown): string => {
        const c = typeof candidate === 'string' ? candidate.trim() : '';
        return c && validUserIds.has(c) ? c : 'usr_admin';
      };

      // 2. Restore Private Networks
      const rawNetworks = Array.isArray(data.privateNetworks)
        ? (data.privateNetworks as Array<Record<string, unknown>>)
        : [];
      for (const rawNet of rawNetworks) {
        const slug = String(rawNet.slug || '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '');
        if (!slug || !/^[a-z0-9-]+$/.test(slug)) continue;
        const dockerName =
          typeof rawNet.dockerName === 'string' && /^sokkan-net-[a-z0-9-]+$/.test(rawNet.dockerName)
            ? rawNet.dockerName
            : `sokkan-net-${slug}`;
        const id =
          typeof rawNet.id === 'string' && rawNet.id.trim()
            ? rawNet.id.trim()
            : `net_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const subnet =
          typeof rawNet.subnet === 'string' && rawNet.subnet.trim() && isValidPrivateSubnet(rawNet.subnet)
            ? rawNet.subnet.trim()
            : '';
        const existingNet = db
          .prepare('SELECT id FROM private_networks WHERE id = ? OR slug = ? OR docker_name = ?')
          .get(id, slug, dockerName);
        if (existingNet) continue;

        db.prepare(
          `INSERT INTO private_networks (
            id, name, slug, docker_name, owner_user_id, description, subnet, internal_only, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          String(rawNet.name || slug).trim(),
          slug,
          dockerName,
          resolveOwnerId(rawNet.ownerUserId),
          String(rawNet.description || '').trim(),
          subnet,
          rawNet.internalOnly === true ? 1 : 0,
          typeof rawNet.createdAt === 'string' && rawNet.createdAt ? rawNet.createdAt : now,
          typeof rawNet.updatedAt === 'string' && rawNet.updatedAt ? rawNet.updatedAt : now,
        );
        counts.privateNetworks += 1;
      }

      const validNetworkIds = new Set(
        (db.prepare('SELECT id FROM private_networks').all() as Array<{ id: string }>).map((n) => n.id),
      );
      const resolveNetId = (candidate: unknown): string | null => {
        const c = typeof candidate === 'string' ? candidate.trim() : '';
        return c && validNetworkIds.has(c) ? c : null;
      };

      // 3. Restore Ready Services (with full decrypted envVars re-encrypted under target server key)
      const rawServices = Array.isArray(data.services)
        ? (data.services as Array<Record<string, unknown>>)
        : [];
      for (const rawSvc of rawServices) {
        const slug = String(rawSvc.slug || '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '');
        if (!slug || !/^[a-z0-9-]+$/.test(slug)) continue;

        const existingSvc = db.prepare('SELECT id FROM services WHERE slug = ?').get(slug);
        if (existingSvc) continue;

        const id =
          typeof rawSvc.id === 'string' && rawSvc.id.trim()
            ? rawSvc.id.trim()
            : `svc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const port = Number(rawSvc.containerPort || 80);
        const safePort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 80;
        const domain = String(rawSvc.domain || '').trim().toLowerCase();
        const safeDomain = domain && validateDomainString(domain) ? domain : '';
        const memLimit = Math.max(64, Math.min(2048, Number(rawSvc.memLimitMb || 256)));
        const envObj = cleanEnvMap(rawSvc.envVars);
        const volumes = Array.isArray(rawSvc.volumes)
          ? rawSvc.volumes.filter(
              (v): v is { name: string; mountPath: string } =>
                Boolean(v && typeof v === 'object' && typeof (v as Record<string, unknown>).name === 'string' && typeof (v as Record<string, unknown>).mountPath === 'string'),
            )
          : [];
        const command = Array.isArray(rawSvc.command)
          ? rawSvc.command.map((c) => String(c))
          : [];
        const primaryNetId = resolveNetId(rawSvc.privateNetworkId);

        db.prepare(
          `INSERT INTO services (
            id, template_id, name, slug, image, category, container_port, domain, caddy_enabled,
            mem_limit_mb, env_vars_enc, volumes_json, command_json, status, last_message,
            owner_user_id, private_network_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          String(rawSvc.templateId || 'custom'),
          String(rawSvc.name || slug),
          slug,
          String(rawSvc.image || ''),
          String(rawSvc.category || 'app'),
          safePort,
          safeDomain,
          rawSvc.caddyEnabled === true && safeDomain ? 1 : 0,
          memLimit,
          encryptSecret(JSON.stringify(envObj)),
          JSON.stringify(volumes),
          JSON.stringify(command),
          'idle',
          'بازیابی‌شده از فایل پشتیبان (آماده راه‌اندازی روی سرور)',
          resolveOwnerId(rawSvc.ownerUserId),
          primaryNetId,
          typeof rawSvc.createdAt === 'string' && rawSvc.createdAt ? rawSvc.createdAt : now,
          typeof rawSvc.updatedAt === 'string' && rawSvc.updatedAt ? rawSvc.updatedAt : now,
        );
        if (primaryNetId) {
          syncPrimaryNetworkAttachment('service', id, slug, primaryNetId, null);
        }
        counts.services += 1;
      }

      // 4. Restore Projects (preserving original ID, GitHub token, webhook secret, envVars, owner & network)
      for (const rawProj of data.projects as Array<Record<string, unknown>>) {
        const slug = String(rawProj.slug || '').trim().toLowerCase();
        if (!/^[a-z0-9-]+$/.test(slug)) continue;
        const existingProj = db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug);
        const existingSvcConflict = db.prepare('SELECT id FROM services WHERE slug = ?').get(slug);
        if (existingProj || existingSvcConflict) continue;

        let canonicalUrl: string;
        let branch: string;
        try {
          canonicalUrl = parseGitHubRepoUrl(String(rawProj.repoUrl || '')).canonicalUrl;
          branch = validateBranchName(String(rawProj.branch || 'main'));
        } catch {
          warnings.push(`پروژه «${slug}» به دلیل آدرس مخزن یا شاخه نامعتبر رد شد.`);
          continue;
        }

        const port = Number(rawProj.containerPort || 3000);
        const domain = String(rawProj.domain || '').trim().toLowerCase();
        if (domain && !validateDomainString(domain)) {
          warnings.push(`پروژه «${slug}» به دلیل دامنه نامعتبر رد شد.`);
          continue;
        }

        const rawId = typeof rawProj.id === 'string' && rawProj.id.trim() ? rawProj.id.trim() : '';
        const idConflict = rawId ? db.prepare('SELECT id FROM projects WHERE id = ?').get(rawId) : null;
        const id =
          rawId && !idConflict
            ? rawId
            : `prj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

        const githubToken = typeof rawProj.githubToken === 'string' ? rawProj.githubToken.trim() : '';
        const webhookSecret =
          typeof rawProj.webhookSecret === 'string' && rawProj.webhookSecret.trim()
            ? rawProj.webhookSecret.trim()
            : generateRandomHex(20);
        const envVarsObj = cleanEnvMap(rawProj.envVars);
        const primaryNetId = resolveNetId(rawProj.privateNetworkId);

        db.prepare(
          `INSERT INTO projects (
            id, name, slug, repo_url, branch, build_mode, deploy_strategy, ghcr_image, actions_compose_file,
            build_file_path, dockerfile_context,
            container_port, domain, caddy_enabled, caddy_extra_directives, auto_deploy_webhook,
            polling_interval_sec, github_token_enc, webhook_secret_enc, env_vars_enc,
            last_commit_sha, last_commit_msg, last_deployed_at, status, owner_user_id, private_network_id,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?)`,
        ).run(
          id,
          String(rawProj.name || slug),
          slug,
          canonicalUrl,
          branch,
          rawProj.buildMode === 'compose' ? 'compose' : 'dockerfile',
          rawProj.deployStrategy === 'github_actions' ? 'github_actions' : 'local',
          typeof rawProj.ghcrImage === 'string' ? rawProj.ghcrImage.trim() : '',
          typeof rawProj.actionsComposeFile === 'string' ? rawProj.actionsComposeFile.trim() : '',
          String(rawProj.buildFilePath || 'Dockerfile'),
          String(rawProj.dockerfileContext || '.'),
          Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3000,
          domain,
          rawProj.caddyEnabled !== false ? 1 : 0,
          String(rawProj.caddyExtraDirectives || ''),
          rawProj.autoDeployWebhook !== false ? 1 : 0,
          Math.max(0, Math.min(86400, Number(rawProj.pollingIntervalSec ?? 300))),
          encryptSecret(githubToken),
          encryptSecret(webhookSecret),
          encryptSecret(JSON.stringify(envVarsObj)),
          String(rawProj.lastCommitSha || ''),
          String(rawProj.lastCommitMsg || ''),
          typeof rawProj.lastDeployedAt === 'string' ? rawProj.lastDeployedAt : null,
          resolveOwnerId(rawProj.ownerUserId),
          primaryNetId,
          typeof rawProj.createdAt === 'string' && rawProj.createdAt ? rawProj.createdAt : now,
          typeof rawProj.updatedAt === 'string' && rawProj.updatedAt ? rawProj.updatedAt : now,
        );

        if (primaryNetId) {
          syncPrimaryNetworkAttachment('project', id, slug, primaryNetId, null);
        }
        counts.projects += 1;
      }

      // 5. Restore Network Attachments
      const validProjectIds = new Set(
        (db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>).map((p) => p.id),
      );
      const validServiceIds = new Set(
        (db.prepare('SELECT id FROM services').all() as Array<{ id: string }>).map((s) => s.id),
      );
      const rawAttachments = Array.isArray(data.networkAttachments)
        ? (data.networkAttachments as Array<Record<string, unknown>>)
        : [];
      for (const rawAtt of rawAttachments) {
        const netId = typeof rawAtt.networkId === 'string' ? rawAtt.networkId.trim() : '';
        const rType = rawAtt.resourceType === 'service' ? 'service' : rawAtt.resourceType === 'project' ? 'project' : null;
        const rId = typeof rawAtt.resourceId === 'string' ? rawAtt.resourceId.trim() : '';
        if (!netId || !rType || !rId || !validNetworkIds.has(netId)) continue;
        if (rType === 'project' && !validProjectIds.has(rId)) continue;
        if (rType === 'service' && !validServiceIds.has(rId)) continue;

        const attId =
          typeof rawAtt.id === 'string' && rawAtt.id.trim()
            ? rawAtt.id.trim()
            : `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const info = db
          .prepare(
            `INSERT INTO network_attachments (id, network_id, resource_type, resource_id, alias, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(network_id, resource_type, resource_id) DO NOTHING`,
          )
          .run(
            attId,
            netId,
            rType,
            rId,
            String(rawAtt.alias || ''),
            typeof rawAtt.createdAt === 'string' && rawAtt.createdAt ? rawAtt.createdAt : now,
          );
        if (info.changes > 0) counts.networkAttachments += 1;
      }

      // 6. Restore Beszel Configuration (including decrypted password re-encrypted under new key)
      if (data.beszel && typeof data.beszel === 'object') {
        const b = data.beszel as Record<string, unknown>;
        try {
          restoreBeszelConfigFromBackup({
            enabled: Boolean(b.enabled),
            url: typeof b.url === 'string' ? b.url : '',
            email: typeof b.email === 'string' ? b.email : '',
            password: typeof b.password === 'string' ? b.password : undefined,
          });
          counts.beszelRestored = true;
        } catch (beszelErr) {
          warnings.push(
            `تنظیمات Beszel بازیابی نشد: ${beszelErr instanceof Error ? beszelErr.message : 'آدرس نامعتبر'}`,
          );
        }
      }

      // 7. Restore Caddy Snapshots History
      const rawSnapshots = Array.isArray(data.caddySnapshots)
        ? (data.caddySnapshots as Array<Record<string, unknown>>)
        : [];
      for (const snap of rawSnapshots) {
        if (typeof snap.content !== 'string' || !snap.content.trim()) continue;
        const snapId =
          typeof snap.id === 'string' && snap.id.trim()
            ? snap.id.trim()
            : `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const info = db
          .prepare(
            `INSERT OR IGNORE INTO caddy_snapshots (id, content, note, applied, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            snapId,
            snap.content,
            String(snap.note || 'اسنپ‌شات بازیابی‌شده'),
            snap.applied === true ? 1 : 0,
            typeof snap.createdAt === 'string' && snap.createdAt ? snap.createdAt : now,
          );
        if (info.changes > 0) counts.caddySnapshots += 1;
      }
    });

    runRestoreTx();

    // Post-transaction: ensure Docker private networks & optionally re-deploy ready services on VPS
    const dockerUp = await isDockerAvailable();
    if (dockerUp) {
      const allNets = db.prepare('SELECT * FROM private_networks').all() as PrivateNetworkRow[];
      for (const net of allNets) {
        try {
          await ensureDockerNetwork(net.docker_name, {
            internal: net.internal_only === 1,
            subnet: net.subnet || undefined,
            ownerUserId: net.owner_user_id,
          });
        } catch (netErr) {
          warnings.push(
            `ساخت شبکه داکر «${net.docker_name}» با هشدار مواجه شد: ${netErr instanceof Error ? netErr.message : 'خطای داکر'}`,
          );
        }
      }

      if (redeployServices) {
        const allServices = db.prepare('SELECT * FROM services ORDER BY created_at ASC').all() as ServiceRow[];
        for (const svc of allServices) {
          const dep = await deployServiceInstance(svc);
          db.prepare('UPDATE services SET status = ?, last_message = ?, updated_at = ? WHERE id = ?').run(
            dep.status,
            dep.message,
            new Date().toISOString(),
            svc.id,
          );
          if (dep.status === 'running') {
            counts.servicesRedeployed += 1;
          } else {
            warnings.push(`راه‌اندازی خودکار سرویس «${svc.name}» ناموفق بود: ${dep.message}`);
          }
        }
      }
    }

    // Apply restored Caddyfile (or fall back to saving in DB with warning if live Caddy reload fails)
    if (typeof data.caddyfile === 'string' && data.caddyfile.trim()) {
      try {
        await applyCaddyfile(data.caddyfile, 'بازیابی کامل از فایل پشتیبان سرور');
        counts.caddyfileRestored = true;
      } catch (caddyErr) {
        setSetting('caddyfile_content', data.caddyfile);
        counts.caddyfileRestored = true;
        warnings.push(
          `Caddyfile در دیتابیس بازیابی شد اما اعمال زنده روی Caddy با هشدار همراه بود: ${caddyErr instanceof Error ? caddyErr.message : 'خطای Caddy'}`,
        );
      }
    } else if (counts.projects > 0 || counts.services > 0) {
      await syncProjectsToCaddyfile('همگام‌سازی مسیرها پس از بازیابی پشتیبان').catch(() => {});
    }

    // Refresh current admin session token so user remains signed in cleanly even after replace mode
    const activeAdmin = db
      .prepare("SELECT * FROM users WHERE id = ? OR id = 'usr_admin' ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1")
      .get(req.authUser?.id || 'usr_admin', req.authUser?.id || 'usr_admin') as UserRow | undefined;
    let refreshedToken: string | undefined;
    let refreshedUser: AuthUser | undefined;
    if (activeAdmin) {
      refreshedUser = {
        id: activeAdmin.id,
        username: activeAdmin.username,
        displayName: activeAdmin.display_name,
        role: activeAdmin.role === 'admin' ? 'admin' : 'member',
      };
      const exp = Date.now() + SESSION_TTL_MS;
      refreshedToken = signSessionToken({
        userId: refreshedUser.id,
        username: refreshedUser.username,
        role: refreshedUser.role,
        exp,
      });
      setSessionCookie(req, res, refreshedToken);
    }

    res.json({
      ok: true,
      schemaVersion,
      mode: requestedMode,
      importedCount: counts.projects,
      restored: counts,
      warnings,
      token: refreshedToken,
      user: refreshedUser,
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در بازیابی فایل پشتیبان',
    });
  }
});

async function startServer() {
  startBackgroundSchedulers();

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'custom',
    });
    app.use(vite.middlewares);

    app.use('*', async (req, res, next) => {
      if (req.originalUrl.startsWith('/api/')) {
        next();
        return;
      }
      try {
        const indexPath = path.resolve(process.cwd(), 'index.html');
        let html = fs.readFileSync(indexPath, 'utf8');
        html = await vite.transformIndexHtml(req.originalUrl, html);
        res.status(200).setHeader('Content-Type', 'text/html').end(html);
      } catch (err) {
        next(err);
      }
    });
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.originalUrl.startsWith('/api/')) {
        next();
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Sokkan PaaS server listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
