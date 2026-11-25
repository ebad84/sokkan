import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  fetchBeszelTelemetry,
  getBeszelConfigPublic,
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
  deployLogBus,
  startBackgroundSchedulers,
  triggerDeployment,
} from './server/cicd.ts';
import {
  decryptSecret,
  encryptSecret,
  generateRandomHex,
  hashPassword,
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
  getSetting,
  type DeploymentRow,
  type ProjectRow,
} from './server/db.ts';
import {
  getContainerLogs,
  getContainerStats,
  getSystemHostMetrics,
  isDockerAvailable,
  isGitAvailable,
  listDockerContainers,
  performContainerAction,
} from './server/docker.ts';
import {
  inspectGitHubRepo,
  parseGitHubRepoUrl,
  validateBranchName,
} from './server/github.ts';

const app = express();
const PORT = Number(process.env.PORT || 3000);

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

      const payload = JSON.parse(rawBody.toString('utf8')) as { ref?: string };
      const expectedRef = `refs/heads/${project.branch}`;
      if (payload.ref && payload.ref !== expectedRef) {
        res.json({
          ok: true,
          ignored: true,
          message: `رویداد مربوط به شاخه ${payload.ref} نادیده گرفته شد (شاخه هدف: ${expectedRef}).`,
        });
        return;
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

  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    repoUrl: p.repo_url,
    branch: p.branch,
    buildMode: p.build_mode,
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
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

const SESSION_COOKIE_NAME = 'sokanyar_session';
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
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (isHttpsRequest(req)) {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req: Request, res: Response): void {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isHttpsRequest(req)) {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

function extractPanelToken(req: Request): string {
  const customHeader = req.header('x-panel-token')?.trim();
  if (customHeader) {
    return customHeader;
  }
  const authHeader = req.header('authorization') ?? '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }
  const cookieToken = readCookieValue(req, SESSION_COOKIE_NAME);
  if (cookieToken) {
    return cookieToken;
  }
  return '';
}

function getAuthState() {
  const envPasscode = process.env.PANEL_ADMIN_PASSCODE?.trim() ?? '';
  const claimedHash = getSetting('admin_password_hash');
  return {
    envPasscodeActive: envPasscode.length > 0,
    needsSetup: envPasscode.length === 0 && !claimedHash,
  };
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractPanelToken(req);
  if (!token) {
    res.status(401).json({ error: 'احراز هویت مدیر الزامی است.' });
    return;
  }
  const payload = verifySessionToken(token);
  if (!payload) {
    res.status(401).json({ error: 'نشست کاربری منقضی شده یا نامعتبر است.' });
    return;
  }
  next();
}

// Public Health & Auth Routes
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/auth/status', (req, res) => {
  const { envPasscodeActive, needsSetup } = getAuthState();
  const token = extractPanelToken(req);
  const authenticated = token ? Boolean(verifySessionToken(token)) : false;
  const caddyUser = (req.header('x-forwarded-user') ?? '').trim();
  res.json({
    authenticated,
    needsSetup,
    envPasscodeActive,
    caddyUser: caddyUser || undefined,
  });
});

app.post('/api/auth/setup', (req, res) => {
  const { envPasscodeActive, needsSetup } = getAuthState();
  if (envPasscodeActive || !needsSetup) {
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
    res.status(409).json({ error: 'رمز مدیر قبلاً ثبت شده است.' });
    return;
  }
  const exp = Date.now() + SESSION_TTL_MS;
  const token = signSessionToken({ role: 'admin', exp });
  setSessionCookie(req, res, token);
  res.status(201).json({ token, expiresAt: exp });
});

app.post('/api/auth/login', (req, res) => {
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password) {
    res.status(400).json({ error: 'رمز عبور را وارد کنید.' });
    return;
  }

  const envPasscode = process.env.PANEL_ADMIN_PASSCODE?.trim() ?? '';
  let valid = false;
  if (envPasscode.length > 0) {
    valid = verifyPlainPasscode(password, envPasscode);
  } else {
    const storedHash = getSetting('admin_password_hash');
    if (!storedHash) {
      res.status(400).json({ error: 'ابتدا رمز مدیر را در فرم راه‌اندازی اولیه ثبت کنید.' });
      return;
    }
    valid = verifyPassword(password, storedHash);
  }

  if (!valid) {
    res.status(401).json({ error: 'رمز عبور نادرست است.' });
    return;
  }

  const exp = Date.now() + SESSION_TTL_MS;
  const token = signSessionToken({ role: 'admin', exp });
  setSessionCookie(req, res, token);
  res.json({ token, expiresAt: exp });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// Protected System Status & Telemetry
app.get('/api/system/status', requireAuth, async (_req, res) => {
  try {
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

    const projectCount = (db.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number }).c;
    const deploymentCount = (db.prepare('SELECT COUNT(*) as c FROM deployments').get() as { c: number }).c;

    res.json({
      executionMode: dockerUp && gitUp ? 'vps' : 'sandbox',
      capabilities: {
        dockerAvailable: dockerUp,
        gitAvailable: gitUp,
        caddyReachable: caddyStatus.reachable,
        caddyMode: caddyStatus.mode,
      },
      counts: {
        projects: projectCount,
        deployments: deploymentCount,
      },
      hostMetrics,
      recentSamples,
      beszel,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'خطا در خواندن وضعیت سرور',
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

// Projects CRUD & CI/CD
app.get('/api/projects', requireAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[];
  res.json(rows.map(serializeProject));
});

app.post('/api/projects', requireAuth, async (req, res) => {
  try {
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

    const branch = validateBranchName(String(body.branch || 'main'));
    const buildMode = body.buildMode === 'compose' ? 'compose' : 'dockerfile';
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
      const domainConflict = db
        .prepare('SELECT name FROM projects WHERE LOWER(domain) = ? AND caddy_enabled = 1')
        .get(domain) as { name: string } | undefined;
      if (domainConflict) {
        res.status(409).json({
          error: `دامنه «${domain}» قبلاً به پروژه «${domainConflict.name}» متصل شده است.`,
        });
        return;
      }
    }

    const caddyExtraDirectives = String(body.caddyExtraDirectives || '');
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
        id, name, slug, repo_url, branch, build_mode, build_file_path, dockerfile_context,
        container_port, domain, caddy_enabled, caddy_extra_directives, auto_deploy_webhook,
        polling_interval_sec, github_token_enc, webhook_secret_enc, env_vars_enc,
        last_commit_sha, last_commit_msg, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
    ).run(
      id,
      name,
      rawSlug,
      canonicalUrl,
      branch,
      buildMode,
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
      now,
      now,
    );

    if (caddyEnabled && domain) {
      await syncProjectsToCaddyfile(`افزودن مسیر پروژه ${rawSlug}`);
    }

    const created = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow;
    res.status(201).json({
      project: serializeProject(created),
      generatedWebhookSecret: webhookSecretInput,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'خطا در ایجاد پروژه';
    res.status(400).json({ error: msg.includes('UNIQUE') ? 'این شناسه پروژه قبلاً ثبت شده است.' : msg });
  }
});

app.patch('/api/projects/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    if (!existing) {
      res.status(404).json({ error: 'پروژه پیدا نشد.' });
      return;
    }

    const body = req.body ?? {};
    const name = body.name !== undefined ? String(body.name).trim() : existing.name;
    const branch = body.branch !== undefined ? validateBranchName(String(body.branch)) : existing.branch;
    const buildMode =
      body.buildMode === 'compose' || body.buildMode === 'dockerfile'
        ? body.buildMode
        : existing.build_mode;
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
      const domainConflict = db
        .prepare('SELECT name FROM projects WHERE LOWER(domain) = ? AND caddy_enabled = 1 AND id != ?')
        .get(domain, id) as { name: string } | undefined;
      if (domainConflict) {
        res.status(409).json({
          error: `دامنه «${domain}» قبلاً به پروژه «${domainConflict.name}» متصل شده است.`,
        });
        return;
      }
    }
    const caddyExtraDirectives =
      body.caddyExtraDirectives !== undefined
        ? String(body.caddyExtraDirectives)
        : existing.caddy_extra_directives;
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
        name = ?, branch = ?, build_mode = ?, build_file_path = ?, container_port = ?,
        domain = ?, caddy_enabled = ?, caddy_extra_directives = ?, auto_deploy_webhook = ?,
        polling_interval_sec = ?, github_token_enc = ?, webhook_secret_enc = ?, env_vars_enc = ?,
        updated_at = ?
       WHERE id = ?`,
    ).run(
      name,
      branch,
      buildMode,
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
      now,
      id,
    );

    await syncProjectsToCaddyfile(`به‌روزرسانی تنظیمات پروژه ${existing.slug}`);
    const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow;
    res.json(serializeProject(updated));
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در ویرایش پروژه',
    });
  }
});

app.delete('/api/projects/:id', requireAuth, async (req, res) => {
  const id = String(req.params.id || '');
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'پروژه پیدا نشد.' });
    return;
  }
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  await syncProjectsToCaddyfile(`حذف مسیر پروژه ${existing.slug}`).catch(() => {});
  res.json({ ok: true });
});

app.post('/api/projects/:id/rotate-webhook', requireAuth, (req, res) => {
  const id = String(req.params.id || '');
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'پروژه پیدا نشد.' });
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

app.post('/api/projects/:id/deploy', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const dep = await triggerDeployment(id, 'manual');
    res.status(202).json(dep);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در شروع دیپلوی',
    });
  }
});

// Deployments & Streaming Logs
app.get('/api/deployments', requireAuth, (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : null;
  const rows = projectId
    ? (db
        .prepare('SELECT * FROM deployments WHERE project_id = ? ORDER BY started_at DESC LIMIT 40')
        .all(projectId) as DeploymentRow[])
    : (db
        .prepare('SELECT * FROM deployments ORDER BY started_at DESC LIMIT 40')
        .all() as DeploymentRow[]);
  res.json(rows);
});

app.get('/api/deployments/:id', requireAuth, (req, res) => {
  const id = String(req.params.id || '');
  const row = db.prepare('SELECT * FROM deployments WHERE id = ?').get(id) as
    | DeploymentRow
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'رکورد دیپلوی پیدا نشد.' });
    return;
  }
  res.json(row);
});

app.get('/api/deployments/:id/stream', requireAuth, (req, res) => {
  const id = String(req.params.id || '');
  const row = db.prepare('SELECT * FROM deployments WHERE id = ?').get(id) as
    | DeploymentRow
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'رکورد دیپلوی پیدا نشد.' });
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

// Docker Containers Control (Replaces Portainer)
app.get('/api/containers', requireAuth, async (_req, res) => {
  const dockerUp = await isDockerAvailable();
  if (!dockerUp) {
    res.json({ dockerAvailable: false, containers: [] });
    return;
  }
  try {
    const containers = await listDockerContainers();
    res.json({ dockerAvailable: true, containers });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'خطا در ارتباط با داکر',
    });
  }
});

app.post('/api/containers/:id/:action', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const action = String(req.params.action || '');
    if (!['start', 'stop', 'restart', 'remove'].includes(action)) {
      res.status(400).json({ error: 'عملیات نامعتبر است.' });
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

app.get('/api/containers/:id/logs', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const tail = Number(req.query.tail || 200);
    const logs = await getContainerLogs(id, tail);
    res.json({ logs });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در خواندن لاگ کانتینر',
    });
  }
});

app.get('/api/containers/:id/stats', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const stats = await getContainerStats(id);
    res.json(stats);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در دریافت آمار مصرف منابع کانتینر',
    });
  }
});

// Caddyfile Global & Managed Routes
app.get('/api/caddy', requireAuth, async (_req, res) => {
  const content = getSetting('caddyfile_content') ?? DEFAULT_CADDYFILE;
  const projects = db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all() as ProjectRow[];
  const managedPreview = renderManagedRoutesBlock(projects);
  const snapshots = listCaddySnapshots(20);
  const caddyStatus = await isCaddyAvailable();

  res.json({
    content,
    managedPreview,
    snapshots,
    caddyStatus,
    routes: projects.map((p) => ({
      projectId: p.id,
      name: p.name,
      slug: p.slug,
      domain: p.domain,
      upstream: `sokanyar-${p.slug}:${p.container_port}`,
      containerPort: p.container_port,
      caddyEnabled: p.caddy_enabled === 1,
      caddyExtraDirectives: p.caddy_extra_directives,
    })),
  });
});

app.post('/api/caddy/validate', requireAuth, async (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const result = await validateCaddyfile(content);
  res.json(result);
});

app.post('/api/caddy/apply', requireAuth, async (req, res) => {
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

app.post('/api/caddy/sync-routes', requireAuth, async (_req, res) => {
  try {
    await syncProjectsToCaddyfile('همگام‌سازی خودکار مسیرهای پروژه');
    res.json({ ok: true, content: getSetting('caddyfile_content') ?? DEFAULT_CADDYFILE });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در همگام‌سازی مسیرهای Caddy',
    });
  }
});

app.post('/api/caddy/rollback/:snapshotId', requireAuth, async (req, res) => {
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

// Beszel Optional Integration
app.get('/api/integrations/beszel', requireAuth, async (_req, res) => {
  const config = getBeszelConfigPublic();
  const telemetry = await fetchBeszelTelemetry();
  res.json({ config, telemetry });
});

app.post('/api/integrations/beszel', requireAuth, async (req, res) => {
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

// VPS Zero-to-One Provisioning & Backup/Restore
app.post('/api/provisioning/generate', requireAuth, (req, res) => {
  const body = req.body ?? {};
  const opts: BootstrapOptions = {
    panelDomain: String(body.panelDomain || 'panel.example.com'),
    caddyEmail: String(body.caddyEmail || 'admin@example.com'),
    dockerNetwork: String(body.dockerNetwork || 'caddy_net').replace(/[^a-zA-Z0-9_-]/g, '') || 'caddy_net',
    panelPort: Math.max(1024, Math.min(65535, Number(body.panelPort || 3000))),
    basicAuthUser: String(body.basicAuthUser || 'admin'),
    includeBeszel: Boolean(body.includeBeszel),
    configureUfw: body.configureUfw !== false,
    panelRepoOrImage: String(body.panelRepoOrImage || 'sokanyar-panel:latest'),
  };
  res.json({
    bootstrapScript: generateBootstrapScript(opts),
    dockerComposeYaml: generatePanelComposeYaml(opts),
    dockerfile: generatePanelDockerfile(),
  });
});

app.get('/api/backup/export', requireAuth, (_req, res) => {
  const projects = db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all() as ProjectRow[];
  const caddyfile = getSetting('caddyfile_content') ?? DEFAULT_CADDYFILE;
  const beszel = getBeszelConfigPublic();

  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    caddyfile,
    beszel: {
      enabled: beszel.enabled,
      url: beszel.url,
      email: beszel.email,
    },
    projects: projects.map((p) => ({
      name: p.name,
      slug: p.slug,
      repoUrl: p.repo_url,
      branch: p.branch,
      buildMode: p.build_mode,
      buildFilePath: p.build_file_path,
      dockerfileContext: p.dockerfile_context,
      containerPort: p.container_port,
      domain: p.domain,
      caddyEnabled: p.caddy_enabled === 1,
      caddyExtraDirectives: p.caddy_extra_directives,
      autoDeployWebhook: p.auto_deploy_webhook === 1,
      pollingIntervalSec: p.polling_interval_sec,
      envKeys: Object.keys(JSON.parse(decryptSecret(p.env_vars_enc) || '{}') as Record<string, string>),
    })),
  };

  res.json(payload);
});

app.post('/api/backup/import', requireAuth, async (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object' || data.schemaVersion !== 1 || !Array.isArray(data.projects)) {
      res.status(400).json({ error: 'فرمت فایل پشتیبان معتبر نیست.' });
      return;
    }

    let importedCount = 0;
    const now = new Date().toISOString();

    for (const rawProj of data.projects as Array<Record<string, unknown>>) {
      const slug = String(rawProj.slug || '').trim().toLowerCase();
      if (!/^[a-z0-9-]+$/.test(slug)) continue;
      const existing = db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug) as
        | { id: string }
        | undefined;
      if (existing) continue;

      const { canonicalUrl } = parseGitHubRepoUrl(String(rawProj.repoUrl || ''));
      const branch = validateBranchName(String(rawProj.branch || 'main'));
      const port = Number(rawProj.containerPort || 3000);
      const domain = String(rawProj.domain || '').trim();
      if (domain && !validateDomainString(domain)) continue;

      const id = `prj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      db.prepare(
        `INSERT INTO projects (
          id, name, slug, repo_url, branch, build_mode, build_file_path, dockerfile_context,
          container_port, domain, caddy_enabled, caddy_extra_directives, auto_deploy_webhook,
          polling_interval_sec, github_token_enc, webhook_secret_enc, env_vars_enc,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, '', 'idle', ?, ?)`,
      ).run(
        id,
        String(rawProj.name || slug),
        slug,
        canonicalUrl,
        branch,
        rawProj.buildMode === 'compose' ? 'compose' : 'dockerfile',
        String(rawProj.buildFilePath || 'Dockerfile'),
        String(rawProj.dockerfileContext || '.'),
        Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3000,
        domain,
        rawProj.caddyEnabled !== false ? 1 : 0,
        String(rawProj.caddyExtraDirectives || ''),
        rawProj.autoDeployWebhook !== false ? 1 : 0,
        Math.max(0, Number(rawProj.pollingIntervalSec ?? 300)),
        encryptSecret(generateRandomHex(20)),
        now,
        now,
      );
      importedCount += 1;
    }

    if (typeof data.caddyfile === 'string' && data.caddyfile.trim()) {
      await applyCaddyfile(data.caddyfile, 'بازیابی از فایل پشتیبان سرور');
    }

    res.json({ ok: true, importedCount });
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
    console.log(`SokanYar CI/CD server listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
