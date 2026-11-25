import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { decryptSecret } from './crypto.ts';
import { syncProjectsToCaddyfile } from './caddy.ts';
import { db, getWorkspacesDir, type DeploymentRow, type ProjectRow } from './db.ts';
import {
  ensureDockerNetwork,
  getSystemHostMetrics,
  isDockerAvailable,
  isGitAvailable,
} from './docker.ts';
import {
  fetchLatestGitHubCommit,
  inspectGitHubRepo,
  parseGitHubRepoUrl,
  validateBranchName,
} from './github.ts';

export const deployLogBus = new EventEmitter();
const activeBuilds = new Set<string>();

function sanitizeSlug(slug: string): string {
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error('اسلاگ پروژه فقط می‌تواند شامل حروف کوچک انگلیسی، عدد و خط تیره باشد.');
  }
  return slug;
}

function resolveProjectWorkspace(slug: string): string {
  const safeSlug = sanitizeSlug(slug);
  const baseDir = getWorkspacesDir();
  const target = path.resolve(baseDir, safeSlug);
  if (!target.startsWith(baseDir + path.sep)) {
    throw new Error('مسیر کاری پروژه خارج از دایرکتوری مجاز است.');
  }
  return target;
}

function appendDeployLog(deploymentId: string, line: string): void {
  const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}\n`;
  db.prepare('UPDATE deployments SET logs = logs || ? WHERE id = ?').run(stamped, deploymentId);
  deployLogBus.emit(`log:${deploymentId}`, stamped);
}

function runCommandSafe(
  cmd: string,
  args: string[],
  cwd: string,
  deploymentId: string,
  extraEnv?: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: false,
      env: { ...process.env, ...(extraEnv ?? {}), GIT_TERMINAL_PROMPT: '0' },
    });

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const l of text.split(/\r?\n/)) {
        if (l.trim()) appendDeployLog(deploymentId, l);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const l of text.split(/\r?\n/)) {
        if (l.trim()) appendDeployLog(deploymentId, l);
      }
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function buildAuthenticatedGitUrl(canonicalUrl: string, token: string): string {
  if (!token) return canonicalUrl;
  // Pass token via https://x-access-token:<token>@github.com/... strictly in-memory for git process
  return canonicalUrl.replace('https://', `https://x-access-token:${encodeURIComponent(token)}@`);
}

function parseEnvVarsJson(raw: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export async function triggerDeployment(
  projectId: string,
  triggerType: 'manual' | 'webhook' | 'polling',
): Promise<DeploymentRow> {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
    | ProjectRow
    | undefined;
  if (!project) {
    throw new Error('پروژه پیدا نشد.');
  }

  if (activeBuilds.has(project.id)) {
    throw new Error('یک فرآیند بیلد و دیپلوی برای این پروژه هم‌اکنون در حال اجرا است.');
  }

  const dockerUp = await isDockerAvailable();
  const gitUp = await isGitAvailable();
  const executionMode = dockerUp && gitUp ? 'vps' : 'sandbox';

  const deploymentId = `dep_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO deployments (id, project_id, trigger_type, status, commit_sha, commit_message, logs, started_at, execution_mode)
     VALUES (?, ?, ?, 'building', ?, ?, '', ?, ?)`,
  ).run(
    deploymentId,
    project.id,
    triggerType,
    project.last_commit_sha || '',
    project.last_commit_msg || '',
    now,
    executionMode,
  );

  db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run(
    'building',
    now,
    project.id,
  );

  activeBuilds.add(project.id);

  // Execute pipeline asynchronously so API responds immediately with deploymentId
  void executePipeline(project, deploymentId, executionMode).finally(() => {
    activeBuilds.delete(project.id);
  });

  return db.prepare('SELECT * FROM deployments WHERE id = ?').get(deploymentId) as DeploymentRow;
}

async function executePipeline(
  project: ProjectRow,
  deploymentId: string,
  executionMode: 'vps' | 'sandbox',
): Promise<void> {
  const token = decryptSecret(project.github_token_enc);
  const envMap = parseEnvVarsJson(decryptSecret(project.env_vars_enc));

  try {
    appendDeployLog(deploymentId, `شروع پایپ‌لاین برای «${project.name}» (${project.slug})`);
    const { canonicalUrl } = parseGitHubRepoUrl(project.repo_url);
    const branch = validateBranchName(project.branch);

    appendDeployLog(deploymentId, `بررسی آخرین کامیت در شاخه ${branch} از گیتهاب...`);
    const latestCommit = await fetchLatestGitHubCommit(canonicalUrl, branch, token);
    if (latestCommit) {
      db.prepare('UPDATE deployments SET commit_sha = ?, commit_message = ? WHERE id = ?').run(
        latestCommit.sha,
        latestCommit.message,
        deploymentId,
      );
      appendDeployLog(
        deploymentId,
        `کامیت شناسایی شد: ${latestCommit.shortSha} — ${latestCommit.message}`,
      );
    }

    if (executionMode === 'sandbox') {
      appendDeployLog(
        deploymentId,
        'حالت پیش‌نمایش (سوکت داکر روی این محیط متصل نیست) — بررسی واقعی ساختار مخزن از گیتهاب...',
      );
      const inspection = await inspectGitHubRepo(canonicalUrl, branch, token);
      appendDeployLog(
        deploymentId,
        `فایل ساخت تشخیص‌داده‌شده: ${inspection.detectedBuildMode} (${inspection.detectedBuildFile})`,
      );
      appendDeployLog(
        deploymentId,
        `پورت‌های شناسایی‌شده: ${inspection.detectedPorts.join(', ')} | پورت انتخابی سرویس: ${project.container_port}`,
      );
      const containerName = `sokanyar-${project.slug}`;
      if (project.build_mode === 'compose') {
        appendDeployLog(
          deploymentId,
          `دستور معادل روی VPS: docker compose -f ${project.build_file_path} up -d --build`,
        );
      } else {
        appendDeployLog(
          deploymentId,
          `دستور معادل روی VPS: docker build -t ${containerName}:latest -f ${project.build_file_path} ${project.dockerfile_context}`,
        );
        appendDeployLog(
          deploymentId,
          `دستور اجرا روی شبکه Caddy: docker run -d --name ${containerName} --network caddy_net --restart unless-stopped ${containerName}:latest`,
        );
      }

      if (project.caddy_enabled === 1 && project.domain.trim()) {
        appendDeployLog(deploymentId, `به‌روزرسانی مسیر دامنه ${project.domain} در Caddyfile...`);
        await syncProjectsToCaddyfile(`همگام‌سازی مسیر پس از بررسی ${project.slug}`);
      }

      const doneAt = new Date().toISOString();
      db.prepare(
        'UPDATE deployments SET status = ?, finished_at = ? WHERE id = ?',
      ).run('success', doneAt, deploymentId);
      db.prepare(
        `UPDATE projects SET status = 'running', last_commit_sha = COALESCE(?, last_commit_sha),
         last_commit_msg = COALESCE(?, last_commit_msg), last_deployed_at = ?, updated_at = ? WHERE id = ?`,
      ).run(
        latestCommit?.sha ?? project.last_commit_sha,
        latestCommit?.message ?? project.last_commit_msg,
        doneAt,
        doneAt,
        project.id,
      );
      appendDeployLog(deploymentId, 'پیش‌نمایش پایپ‌لاین با موفقیت کامل شد.');
      deployLogBus.emit(`done:${deploymentId}`, 'success');
      return;
    }

    // Real VPS Execution Mode
    const workspaceDir = resolveProjectWorkspace(project.slug);
    const gitUrl = buildAuthenticatedGitUrl(canonicalUrl, token);

    if (!fs.existsSync(path.join(workspaceDir, '.git'))) {
      appendDeployLog(deploymentId, `کلون کردن مخزن در ${workspaceDir}...`);
      if (fs.existsSync(workspaceDir)) {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
      fs.mkdirSync(workspaceDir, { recursive: true });
      const cloneCode = await runCommandSafe(
        'git',
        ['clone', '--branch', branch, '--single-branch', gitUrl, '.'],
        workspaceDir,
        deploymentId,
      );
      if (cloneCode !== 0) {
        throw new Error(`عملیات git clone با کد ${cloneCode} متوقف شد.`);
      }
    } else {
      appendDeployLog(deploymentId, `دریافت آپدیت‌های جدید از شاخه ${branch}...`);
      await runCommandSafe('git', ['remote', 'set-url', 'origin', gitUrl], workspaceDir, deploymentId);
      const fetchCode = await runCommandSafe(
        'git',
        ['fetch', 'origin', branch],
        workspaceDir,
        deploymentId,
      );
      if (fetchCode !== 0) {
        throw new Error(`عملیات git fetch با کد ${fetchCode} ناموفق بود.`);
      }
      const resetCode = await runCommandSafe(
        'git',
        ['reset', '--hard', `origin/${branch}`],
        workspaceDir,
        deploymentId,
      );
      if (resetCode !== 0) {
        throw new Error(`به‌روزرسانی فایل‌های کاری با کد ${resetCode} ناموفق بود.`);
      }
    }

    // Write project .env file securely inside workspace
    if (Object.keys(envMap).length > 0) {
      const envLines = Object.entries(envMap)
        .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join('\n');
      fs.writeFileSync(path.join(workspaceDir, '.env'), envLines + '\n', { mode: 0o600 });
      appendDeployLog(deploymentId, 'فایل متغیرهای محیطی (.env) در فضای کاری نوشته شد.');
    }

    await ensureDockerNetwork('caddy_net');
    const containerName = `sokanyar-${project.slug}`;

    if (project.build_mode === 'compose') {
      const composeFile = path.basename(project.build_file_path || 'docker-compose.yml');
      appendDeployLog(deploymentId, `اجرای docker compose با فایل ${composeFile}...`);
      const upCode = await runCommandSafe(
        'docker',
        ['compose', '-p', containerName, '-f', composeFile, 'up', '-d', '--build', '--remove-orphans'],
        workspaceDir,
        deploymentId,
      );
      if (upCode !== 0) {
        throw new Error(`اجرای docker compose ناموفق بود (کد ${upCode}).`);
      }
    } else {
      const dockerfileName = path.basename(project.build_file_path || 'Dockerfile');
      const contextRel = project.dockerfile_context?.trim() || '.';
      const resolvedContext = path.resolve(workspaceDir, contextRel);
      if (
        resolvedContext !== workspaceDir &&
        !resolvedContext.startsWith(workspaceDir + path.sep)
      ) {
        throw new Error('مسیر کانتکست بیلد خارج از فضای کاری پروژه است.');
      }

      const imageTag = `${containerName}:latest`;
      appendDeployLog(deploymentId, `ساخت ایمیج داکر ${imageTag}...`);
      const buildCode = await runCommandSafe(
        'docker',
        ['build', '-t', imageTag, '-f', dockerfileName, contextRel],
        workspaceDir,
        deploymentId,
      );
      if (buildCode !== 0) {
        throw new Error(`ساخت ایمیج داکر ناموفق بود (کد ${buildCode}).`);
      }

      appendDeployLog(deploymentId, `جایگزینی کانتینر ${containerName} روی شبکه caddy_net...`);
      await runCommandSafe('docker', ['rm', '-f', containerName], workspaceDir, deploymentId).catch(
        () => 0,
      );

      const runArgs = [
        'run',
        '-d',
        '--name',
        containerName,
        '--network',
        'caddy_net',
        '--restart',
        'unless-stopped',
        '--label',
        'sokanyar.managed=true',
        '--label',
        `sokanyar.project=${project.slug}`,
      ];
      if (fs.existsSync(path.join(workspaceDir, '.env'))) {
        runArgs.push('--env-file', path.join(workspaceDir, '.env'));
      }
      runArgs.push(imageTag);

      const runCode = await runCommandSafe('docker', runArgs, workspaceDir, deploymentId);
      if (runCode !== 0) {
        throw new Error(`اجرای کانتینر جدید با خطا مواجه شد (کد ${runCode}).`);
      }
    }

    if (project.caddy_enabled === 1 && project.domain.trim()) {
      appendDeployLog(deploymentId, `همگام‌سازی دامنه ${project.domain} و Reload کردن Caddy...`);
      await syncProjectsToCaddyfile(`دیپلوی خودکار ${project.slug}`);
    }

    const doneAt = new Date().toISOString();
    db.prepare('UPDATE deployments SET status = ?, finished_at = ? WHERE id = ?').run(
      'success',
      doneAt,
      deploymentId,
    );
    db.prepare(
      `UPDATE projects SET status = 'running', last_commit_sha = COALESCE(?, last_commit_sha),
       last_commit_msg = COALESCE(?, last_commit_msg), last_deployed_at = ?, updated_at = ? WHERE id = ?`,
    ).run(
      latestCommit?.sha ?? project.last_commit_sha,
      latestCommit?.message ?? project.last_commit_msg,
      doneAt,
      doneAt,
      project.id,
    );

    appendDeployLog(deploymentId, 'دیپلوی با موفقیت به پایان رسید.');
    deployLogBus.emit(`done:${deploymentId}`, 'success');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'خطای ناشناخته در دیپلوی';
    appendDeployLog(deploymentId, `خطا: ${errMsg}`);
    const doneAt = new Date().toISOString();
    db.prepare('UPDATE deployments SET status = ?, finished_at = ? WHERE id = ?').run(
      'failed',
      doneAt,
      deploymentId,
    );
    db.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?').run(
      'error',
      doneAt,
      project.id,
    );
    deployLogBus.emit(`done:${deploymentId}`, 'failed');
  }
}

export async function runPollingCycle(): Promise<void> {
  const projects = db
    .prepare('SELECT * FROM projects WHERE polling_interval_sec > 0')
    .all() as ProjectRow[];
  const nowMs = Date.now();

  for (const project of projects) {
    if (activeBuilds.has(project.id)) continue;
    const lastPolledMs = project.last_polled_at ? Date.parse(project.last_polled_at) : 0;
    if (nowMs - lastPolledMs < project.polling_interval_sec * 1000) {
      continue;
    }

    db.prepare('UPDATE projects SET last_polled_at = ? WHERE id = ?').run(
      new Date(nowMs).toISOString(),
      project.id,
    );

    try {
      const token = decryptSecret(project.github_token_enc);
      const latest = await fetchLatestGitHubCommit(project.repo_url, project.branch, token);
      if (latest && latest.sha && project.last_commit_sha && latest.sha !== project.last_commit_sha) {
        await triggerDeployment(project.id, 'polling');
      } else if (latest && latest.sha && !project.last_commit_sha) {
        db.prepare('UPDATE projects SET last_commit_sha = ?, last_commit_msg = ? WHERE id = ?').run(
          latest.sha,
          latest.message,
          project.id,
        );
      }
    } catch {
      // Keep polling loop resilient on transient GitHub network errors
    }
  }
}

let schedulerStarted = false;

export function startBackgroundSchedulers(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;

  // Poll GitHub repos every 30s (checks per-project polling_interval_sec)
  setInterval(() => {
    void runPollingCycle();
  }, 30_000);

  // Sample host metrics every 60s for local historical charts
  const sampleHost = async () => {
    try {
      const m = await getSystemHostMetrics();
      db.prepare(
        `INSERT INTO metric_samples (cpu_percent, mem_percent, mem_used_mb, mem_total_mb, disk_percent, sampled_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(m.cpuLoadPercent, m.memPercent, m.memUsedMb, m.memTotalMb, m.diskPercent, m.sampledAt);
      // Retain last 240 samples (~4 hours)
      db.prepare(
        'DELETE FROM metric_samples WHERE id NOT IN (SELECT id FROM metric_samples ORDER BY id DESC LIMIT 240)',
      ).run();
    } catch {
      // Ignore sample errors
    }
  };
  void sampleHost();
  setInterval(() => {
    void sampleHost();
  }, 60_000);
}
