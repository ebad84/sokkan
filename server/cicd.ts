import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { decryptSecret } from './crypto.ts';
import { syncProjectsToCaddyfile } from './caddy.ts';
import {
  db,
  getResourcePrivateNetworks,
  getWorkspacesDir,
  type DeploymentRow,
  type ProjectRow,
} from './db.ts';
import {
  connectContainerToNetwork,
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
import { resolveGitHubTokenForRepo } from './githubApp.ts';

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

export function cleanupProjectWorkspace(slug: string): void {
  try {
    const workspaceDir = resolveProjectWorkspace(slug);
    if (fs.existsSync(workspaceDir)) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors for non-existent or invalid workspace paths
  }
}

function resolveConfinedBuildFile(
  workspaceDir: string,
  requestedPath: string,
  fallbackFile: string,
): string {
  const relRaw = (requestedPath || fallbackFile).trim().replace(/^\/+/, '');
  const resolved = path.resolve(workspaceDir, relRaw || fallbackFile);
  if (!resolved.startsWith(workspaceDir + path.sep)) {
    throw new Error('مسیر فایل ساخت (Dockerfile/Compose) خارج از فضای کاری مجاز پروژه است.');
  }
  return path.relative(workspaceDir, resolved);
}

function scrubSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) {
      out = out.split(s).join('***');
      const encoded = encodeURIComponent(s);
      if (encoded !== s) {
        out = out.split(encoded).join('***');
      }
    }
  }
  return out;
}

function appendDeployLog(deploymentId: string, line: string, secretsToMask: string[] = []): void {
  const safeLine = secretsToMask.length > 0 ? scrubSecrets(line, secretsToMask) : line;
  const stamped = `[${new Date().toISOString().slice(11, 19)}] ${safeLine}\n`;
  db.prepare('UPDATE deployments SET logs = logs || ? WHERE id = ?').run(stamped, deploymentId);
  deployLogBus.emit(`log:${deploymentId}`, stamped);
}

function runCommandSafe(
  cmd: string,
  args: string[],
  cwd: string,
  deploymentId: string,
  extraEnv?: Record<string, string>,
  secretsToMask: string[] = [],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: false,
      env: {
        ...process.env,
        DOCKER_BUILDKIT: '1',
        COMPOSE_DOCKER_CLI_BUILD: '1',
        ...(extraEnv ?? {}),
        GIT_TERMINAL_PROMPT: '0',
      },
    });

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const l of text.split(/\r?\n/)) {
        if (l.trim()) appendDeployLog(deploymentId, l, secretsToMask);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const l of text.split(/\r?\n/)) {
        if (l.trim()) appendDeployLog(deploymentId, l, secretsToMask);
      }
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function validateDockerImageRef(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(trimmed) || trimmed.includes('..')) {
    throw new Error('آدرس ایمیج داکر (GHCR) نامعتبر است.');
  }
  return trimmed;
}

function dockerLoginGhcr(
  username: string,
  token: string,
  cwd: string,
  deploymentId: string,
  secretsToMask: string[] = [],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['login', 'ghcr.io', '-u', username, '--password-stdin'], {
      cwd,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    child.stdout.on('data', (chunk: Buffer) => {
      for (const l of chunk.toString('utf8').split(/\r?\n/)) {
        if (l.trim()) appendDeployLog(deploymentId, l, secretsToMask);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      for (const l of chunk.toString('utf8').split(/\r?\n/)) {
        if (l.trim()) appendDeployLog(deploymentId, l, secretsToMask);
      }
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve(code ?? 1));
    child.stdin.write(token + '\n');
    child.stdin.end();
  });
}

function buildGitAuthArgs(token: string): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return ['-c', `http.extraheader=AUTHORIZATION: basic ${basic}`];
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
  const manualPat = decryptSecret(project.github_token_enc);
  let token = manualPat;
  const envMap = parseEnvVarsJson(decryptSecret(project.env_vars_enc));

  try {
    appendDeployLog(deploymentId, `شروع پایپ‌لاین برای «${project.name}» (${project.slug})`);
    const { owner, repo, canonicalUrl } = parseGitHubRepoUrl(project.repo_url);
    const resolvedAuth = await resolveGitHubTokenForRepo(
      owner,
      manualPat,
      project.github_installation_id || undefined,
    );
    token = resolvedAuth.token;
    const ghcrUsername = resolvedAuth.username || owner;
    if (resolvedAuth.source === 'github_app') {
      appendDeployLog(deploymentId, 'احراز هویت گیتهاب از طریق توکن موقت GitHub App انجام شد.');
    }
    const deployStrategy = project.deploy_strategy === 'github_actions' ? 'github_actions' : 'local';
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
      const privateNets = getResourcePrivateNetworks('project', project.id, project.private_network_id);
      const defaultNet = process.env.DOCKER_NETWORK?.trim() || 'web';
      const targetNetNames =
        privateNets.length > 0 ? privateNets.map((n) => n.docker_name) : [defaultNet];
      const containerName = `sokkan-${project.slug}`;
      if (deployStrategy === 'github_actions') {
        if (project.build_mode === 'compose') {
          const cf = project.actions_compose_file.trim() || 'docker-compose.ghcr.yml';
          appendDeployLog(
            deploymentId,
            `حالت GitHub Actions (Compose) — دستور معادل روی VPS: docker compose -f ${cf} pull && docker compose -f ${cf} up -d --no-build`,
          );
        } else {
          const img =
            project.ghcr_image.trim() || `ghcr.io/${owner.toLowerCase()}/${repo.toLowerCase()}:latest`;
          appendDeployLog(
            deploymentId,
            `حالت GitHub Actions (GHCR) — دستور معادل روی VPS: docker pull ${img} && docker run -d --name ${containerName} --network ${targetNetNames[0]} ${img}`,
          );
        }
      } else if (project.build_mode === 'compose') {
        appendDeployLog(
          deploymentId,
          `دستور معادل روی VPS (BuildKit): docker compose -f ${project.build_file_path} up -d --build (شبکه: ${targetNetNames.join(', ')})`,
        );
      } else {
        appendDeployLog(
          deploymentId,
          `دستور معادل روی VPS (BuildKit): docker build -t ${containerName}:latest -f ${project.build_file_path} ${project.dockerfile_context}`,
        );
        appendDeployLog(
          deploymentId,
          `دستور اجرا روی شبکه ${targetNetNames[0]}: docker run -d --name ${containerName} --network ${targetNetNames[0]} --network-alias ${project.slug} --restart unless-stopped ${containerName}:latest`,
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
    const gitAuthArgs = buildGitAuthArgs(token);
    const secretsToMask = token ? [token, Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')] : [];

    if (!fs.existsSync(path.join(workspaceDir, '.git'))) {
      appendDeployLog(deploymentId, `کلون کردن مخزن در ${workspaceDir}...`, secretsToMask);
      if (fs.existsSync(workspaceDir)) {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
      fs.mkdirSync(workspaceDir, { recursive: true });
      const cloneCode = await runCommandSafe(
        'git',
        [...gitAuthArgs, 'clone', '--branch', branch, '--single-branch', canonicalUrl, '.'],
        workspaceDir,
        deploymentId,
        undefined,
        secretsToMask,
      );
      if (cloneCode !== 0) {
        throw new Error(`عملیات git clone با کد ${cloneCode} متوقف شد.`);
      }
    } else {
      appendDeployLog(deploymentId, `دریافت آپدیت‌های جدید از شاخه ${branch}...`, secretsToMask);
      // Ensure origin URL stays tokenless on disk (.git/config)
      await runCommandSafe(
        'git',
        ['remote', 'set-url', 'origin', canonicalUrl],
        workspaceDir,
        deploymentId,
        undefined,
        secretsToMask,
      );
      const fetchCode = await runCommandSafe(
        'git',
        [...gitAuthArgs, 'fetch', 'origin', branch],
        workspaceDir,
        deploymentId,
        undefined,
        secretsToMask,
      );
      if (fetchCode !== 0) {
        throw new Error(`عملیات git fetch با کد ${fetchCode} ناموفق بود.`);
      }
      const resetCode = await runCommandSafe(
        'git',
        ['reset', '--hard', `origin/${branch}`],
        workspaceDir,
        deploymentId,
        undefined,
        secretsToMask,
      );
      if (resetCode !== 0) {
        throw new Error(`به‌روزرسانی فایل‌های کاری با کد ${resetCode} ناموفق بود.`);
      }
    }

    // Write project .env file securely inside workspace without literal JSON quotes (Docker --env-file does not unquote values)
    const envFilePath = path.join(workspaceDir, '.env');
    const validEnvEntries = Object.entries(envMap).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
    if (validEnvEntries.length > 0) {
      const envLines = validEnvEntries
        .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, ' ')}`)
        .join('\n');
      fs.writeFileSync(envFilePath, envLines + '\n', { mode: 0o600 });
      appendDeployLog(deploymentId, 'فایل متغیرهای محیطی (.env) در فضای کاری نوشته شد.');
    } else if (fs.existsSync(envFilePath)) {
      fs.unlinkSync(envFilePath);
    }

    const privateNets = getResourcePrivateNetworks('project', project.id, project.private_network_id);
    const fallbackNetwork = process.env.DOCKER_NETWORK?.trim() || 'web';
    const primaryNet = privateNets[0]?.docker_name || fallbackNetwork;

    if (privateNets.length > 0) {
      for (const pNet of privateNets) {
        await ensureDockerNetwork(pNet.docker_name, {
          internal: pNet.internal_only === 1,
          subnet: pNet.subnet || undefined,
          ownerUserId: pNet.owner_user_id,
        });
      }
    } else {
      await ensureDockerNetwork(fallbackNetwork);
    }

    const containerName = `sokkan-${project.slug}`;

    if (deployStrategy === 'github_actions') {
      appendDeployLog(
        deploymentId,
        'حالت GitHub Actions فعال است — بدون بیلد روی VPS، دریافت مستقیم ایمیج آماده (GHCR)...',
      );
      if (token) {
        appendDeployLog(
          deploymentId,
          `احراز هویت در رجیستری ghcr.io (${resolvedAuth.source === 'github_app' ? 'GitHub App' : `حساب ${owner}`})...`,
          secretsToMask,
        );
        const loginCode = await dockerLoginGhcr(
          ghcrUsername,
          token,
          workspaceDir,
          deploymentId,
          secretsToMask,
        );
        if (loginCode !== 0) {
          appendDeployLog(
            deploymentId,
            'هشدار: ورود به ghcr.io ناموفق بود (برای ایمیج‌های عمومی مشکلی نیست؛ برای ایمیج خصوصی دسترسی read:packages لازم است).',
          );
        }
      }

      if (project.build_mode === 'compose') {
        const defaultGhcrFile = fs.existsSync(path.join(workspaceDir, 'docker-compose.ghcr.yml'))
          ? 'docker-compose.ghcr.yml'
          : project.build_file_path || 'docker-compose.yml';
        const composeFile = resolveConfinedBuildFile(
          workspaceDir,
          project.actions_compose_file.trim() || defaultGhcrFile,
          'docker-compose.ghcr.yml',
        );
        appendDeployLog(deploymentId, `دریافت ایمیج‌های آماده با ${composeFile} (docker compose pull)...`);
        const pullCode = await runCommandSafe(
          'docker',
          ['compose', '-p', containerName, '-f', composeFile, 'pull'],
          workspaceDir,
          deploymentId,
          undefined,
          secretsToMask,
        );
        if (pullCode !== 0) {
          throw new Error(`دریافت ایمیج‌های آماده (docker compose pull) ناموفق بود (کد ${pullCode}).`);
        }
        appendDeployLog(deploymentId, `اجرای سرویس‌ها بدون بیلد محلی (${composeFile})...`);
        const upCode = await runCommandSafe(
          'docker',
          ['compose', '-p', containerName, '-f', composeFile, 'up', '-d', '--no-build', '--remove-orphans'],
          workspaceDir,
          deploymentId,
          undefined,
          secretsToMask,
        );
        if (upCode !== 0) {
          throw new Error(`اجرای docker compose ناموفق بود (کد ${upCode}).`);
        }
      } else {
        const imageRef = validateDockerImageRef(
          project.ghcr_image.trim() || `ghcr.io/${owner.toLowerCase()}/${repo.toLowerCase()}:latest`,
        );
        appendDeployLog(deploymentId, `دریافت ایمیج آماده ${imageRef}...`);
        const pullCode = await runCommandSafe(
          'docker',
          ['pull', imageRef],
          workspaceDir,
          deploymentId,
          undefined,
          secretsToMask,
        );
        if (pullCode !== 0) {
          throw new Error(`دریافت ایمیج ${imageRef} ناموفق بود (کد ${pullCode}).`);
        }

        appendDeployLog(deploymentId, `جایگزینی کانتینر ${containerName} روی شبکه ${primaryNet}...`);
        await runCommandSafe('docker', ['rm', '-f', containerName], workspaceDir, deploymentId).catch(
          () => 0,
        );

        const runArgs = [
          'run',
          '-d',
          '--name',
          containerName,
          '--network',
          primaryNet,
          '--network-alias',
          project.slug,
          '--restart',
          'unless-stopped',
          '--label',
          'sokkan.managed=true',
          '--label',
          `sokkan.project=${project.slug}`,
          '--label',
          `sokkan.owner=${project.owner_user_id}`,
        ];
        if (fs.existsSync(path.join(workspaceDir, '.env'))) {
          runArgs.push('--env-file', path.join(workspaceDir, '.env'));
        }
        runArgs.push(imageRef);

        const runCode = await runCommandSafe('docker', runArgs, workspaceDir, deploymentId);
        if (runCode !== 0) {
          throw new Error(`اجرای کانتینر جدید با خطا مواجه شد (کد ${runCode}).`);
        }

        for (const extraNet of privateNets.slice(1)) {
          appendDeployLog(deploymentId, `اتصال کانتینر به شبکه خصوصی ${extraNet.name} (${extraNet.docker_name})...`);
          await connectContainerToNetwork(containerName, extraNet.docker_name, [project.slug]);
        }
      }
    } else if (project.build_mode === 'compose') {
      const composeFile = resolveConfinedBuildFile(
        workspaceDir,
        project.build_file_path,
        'docker-compose.yml',
      );
      appendDeployLog(deploymentId, `اجرای docker compose (BuildKit) با فایل ${composeFile}...`);
      const upCode = await runCommandSafe(
        'docker',
        ['compose', '-p', containerName, '-f', composeFile, 'up', '-d', '--build', '--remove-orphans'],
        workspaceDir,
        deploymentId,
        undefined,
        secretsToMask,
      );
      if (upCode !== 0) {
        throw new Error(`اجرای docker compose ناموفق بود (کد ${upCode}).`);
      }
    } else {
      const dockerfileRel = resolveConfinedBuildFile(
        workspaceDir,
        project.build_file_path,
        'Dockerfile',
      );
      const contextRel = project.dockerfile_context?.trim() || '.';
      const resolvedContext = path.resolve(workspaceDir, contextRel);
      if (
        resolvedContext !== workspaceDir &&
        !resolvedContext.startsWith(workspaceDir + path.sep)
      ) {
        throw new Error('مسیر کانتکست بیلد خارج از فضای کاری پروژه است.');
      }

      const imageTag = `${containerName}:latest`;
      appendDeployLog(deploymentId, `ساخت ایمیج داکر ${imageTag} با BuildKit...`);
      const buildCode = await runCommandSafe(
        'docker',
        ['build', '-t', imageTag, '-f', dockerfileRel, contextRel],
        workspaceDir,
        deploymentId,
        undefined,
        secretsToMask,
      );
      if (buildCode !== 0) {
        throw new Error(`ساخت ایمیج داکر ناموفق بود (کد ${buildCode}).`);
      }

      appendDeployLog(deploymentId, `جایگزینی کانتینر ${containerName} روی شبکه ${primaryNet}...`);
      await runCommandSafe('docker', ['rm', '-f', containerName], workspaceDir, deploymentId).catch(
        () => 0,
      );

      const runArgs = [
        'run',
        '-d',
        '--name',
        containerName,
        '--network',
        primaryNet,
        '--network-alias',
        project.slug,
        '--restart',
        'unless-stopped',
        '--label',
        'sokkan.managed=true',
        '--label',
        `sokkan.project=${project.slug}`,
        '--label',
        `sokkan.owner=${project.owner_user_id}`,
      ];
      if (fs.existsSync(path.join(workspaceDir, '.env'))) {
        runArgs.push('--env-file', path.join(workspaceDir, '.env'));
      }
      runArgs.push(imageTag);

      const runCode = await runCommandSafe('docker', runArgs, workspaceDir, deploymentId);
      if (runCode !== 0) {
        throw new Error(`اجرای کانتینر جدید با خطا مواجه شد (کد ${runCode}).`);
      }

      for (const extraNet of privateNets.slice(1)) {
        appendDeployLog(deploymentId, `اتصال کانتینر به شبکه خصوصی ${extraNet.name} (${extraNet.docker_name})...`);
        await connectContainerToNetwork(containerName, extraNet.docker_name, [project.slug]);
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
    const rawMsg = err instanceof Error ? err.message : 'خطای ناشناخته در دیپلوی';
    const errMsg = token ? scrubSecrets(rawMsg, [token]) : rawMsg;
    appendDeployLog(deploymentId, `خطا: ${errMsg}`, token ? [token] : []);
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
    if (project.deploy_strategy === 'github_actions') continue;
    const lastPolledMs = project.last_polled_at ? Date.parse(project.last_polled_at) : 0;
    if (nowMs - lastPolledMs < project.polling_interval_sec * 1000) {
      continue;
    }

    db.prepare('UPDATE projects SET last_polled_at = ? WHERE id = ?').run(
      new Date(nowMs).toISOString(),
      project.id,
    );

    try {
      const manualPat = decryptSecret(project.github_token_enc);
      const { owner } = parseGitHubRepoUrl(project.repo_url);
      const resolvedAuth = await resolveGitHubTokenForRepo(
        owner,
        manualPat,
        project.github_installation_id || undefined,
      );
      const latest = await fetchLatestGitHubCommit(
        project.repo_url,
        project.branch,
        resolvedAuth.token,
      );
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
