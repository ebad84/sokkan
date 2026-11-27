import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface LocalVersionInfo {
  version: string;
  commitSha: string | null;
  repo: string;
  branch: string;
}

export interface RemoteCommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

export interface UpdateCheckResult {
  status: 'up_to_date' | 'update_available' | 'ahead' | 'error';
  checkedAt: string;
  repo: string;
  branch: string;
  currentVersion: string;
  currentCommit: string | null;
  latestVersion: string | null;
  latestReleaseTag: string | null;
  latestReleaseUrl: string | null;
  latestReleaseNotes: string | null;
  latestCommit: RemoteCommitInfo | null;
  commitsBehind: number | null;
  summary: string;
  updateCommand: string;
  fallbackUpdateCommand: string;
  error?: string;
}

const DEFAULT_REPO = 'ebad84/sokkan';
const DEFAULT_BRANCH = 'main';
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const COMMIT_PATTERN = /^[a-f0-9]{7,40}$/i;

function getConfiguredRepo(): string {
  const raw = (process.env.SOKKAN_UPDATE_REPO || '').trim();
  if (raw && REPO_PATTERN.test(raw)) {
    return raw;
  }
  return DEFAULT_REPO;
}

function getConfiguredBranch(): string {
  const raw = (process.env.SOKKAN_UPDATE_BRANCH || '').trim();
  if (raw && BRANCH_PATTERN.test(raw) && !raw.includes('..')) {
    return raw;
  }
  return DEFAULT_BRANCH;
}

function readPackageVersion(): string {
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // Fallback below
  }
  return '1.1.0';
}

function readLocalCommitSha(): string | null {
  const envCommit = (process.env.SOKKAN_COMMIT_SHA || '').trim();
  if (COMMIT_PATTERN.test(envCommit)) {
    return envCommit.slice(0, 7).toLowerCase();
  }
  try {
    const out = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (COMMIT_PATTERN.test(out)) {
      return out.toLowerCase();
    }
  } catch {
    // Not a git checkout (e.g., Docker image or sandbox)
  }
  return null;
}

let cachedLocalInfo: LocalVersionInfo | null = null;

export function getLocalVersionInfo(): LocalVersionInfo {
  if (!cachedLocalInfo) {
    cachedLocalInfo = {
      version: readPackageVersion(),
      commitSha: readLocalCommitSha(),
      repo: getConfiguredRepo(),
      branch: getConfiguredBranch(),
    };
  }
  return cachedLocalInfo;
}

function normalizeSemver(input: string | null | undefined): [number, number, number] | null {
  if (!input) return null;
  const cleaned = input.trim().replace(/^v/i, '').split('-')[0];
  const parts = cleaned.split('.');
  if (parts.length < 2 || parts.length > 3) return null;
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const patch = parts.length === 3 ? Number(parts[2]) : 0;
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return null;
  }
  if (major < 0 || minor < 0 || patch < 0) return null;
  return [major, minor, patch];
}

function compareSemver(a: string, b: string): number | null {
  const va = normalizeSemver(a);
  const vb = normalizeSemver(b);
  if (!va || !vb) return null;
  for (let i = 0; i < 3; i++) {
    if (va[i] > vb[i]) return 1;
    if (va[i] < vb[i]) return -1;
  }
  return 0;
}

function sanitizeGitHubUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && parsed.hostname === 'github.com') {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const local = getLocalVersionInfo();
  const checkedAt = new Date().toISOString();
  const updateCommand = 'sokkan update';
  const fallbackUpdateCommand =
    'cd /opt/sokkan && git pull --ff-only && sudo docker compose up -d --build sokkan-panel';

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `sokkan-panel/${local.version}`,
  };

  try {
    const [releaseRes, commitRes, pkgRes] = await Promise.allSettled([
      fetch(`https://api.github.com/repos/${local.repo}/releases/latest`, {
        headers,
        signal: AbortSignal.timeout(8000),
      }),
      fetch(
        `https://api.github.com/repos/${local.repo}/commits/${encodeURIComponent(local.branch)}`,
        {
          headers,
          signal: AbortSignal.timeout(8000),
        },
      ),
      fetch(
        `https://raw.githubusercontent.com/${local.repo}/${encodeURIComponent(local.branch)}/package.json`,
        {
          headers: { 'User-Agent': `sokkan-panel/${local.version}` },
          signal: AbortSignal.timeout(8000),
        },
      ),
    ]);

    let latestReleaseTag: string | null = null;
    let latestReleaseUrl: string | null = null;
    let latestReleaseNotes: string | null = null;

    if (releaseRes.status === 'fulfilled' && releaseRes.value.ok) {
      const data = (await releaseRes.value.json()) as {
        tag_name?: string;
        html_url?: string;
        body?: string;
      };
      if (typeof data.tag_name === 'string' && data.tag_name.trim()) {
        latestReleaseTag = data.tag_name.trim().replace(/^v/i, '');
      }
      latestReleaseUrl = sanitizeGitHubUrl(data.html_url);
      if (typeof data.body === 'string' && data.body.trim()) {
        latestReleaseNotes = data.body.trim().slice(0, 400);
      }
    }

    let remotePkgVersion: string | null = null;
    if (pkgRes.status === 'fulfilled' && pkgRes.value.ok) {
      try {
        const pkgData = (await pkgRes.value.json()) as { version?: unknown };
        if (typeof pkgData.version === 'string' && pkgData.version.trim()) {
          remotePkgVersion = pkgData.version.trim().replace(/^v/i, '');
        }
      } catch {
        // Ignore malformed package.json
      }
    }

    let latestCommit: RemoteCommitInfo | null = null;
    let commitApiError: string | null = null;

    if (commitRes.status === 'fulfilled') {
      if (commitRes.value.ok) {
        const data = (await commitRes.value.json()) as {
          sha?: string;
          html_url?: string;
          commit?: {
            message?: string;
            author?: { name?: string; date?: string };
            committer?: { date?: string };
          };
        };
        if (typeof data.sha === 'string' && data.sha.length >= 7) {
          const fullMsg = String(data.commit?.message || '').trim();
          const firstLine = fullMsg.split('\n')[0] || '';
          latestCommit = {
            sha: data.sha,
            shortSha: data.sha.slice(0, 7).toLowerCase(),
            message: firstLine.slice(0, 160),
            author: String(data.commit?.author?.name || '').slice(0, 80),
            date: String(data.commit?.committer?.date || data.commit?.author?.date || ''),
            url: sanitizeGitHubUrl(data.html_url) ?? `https://github.com/${local.repo}/commit/${data.sha}`,
          };
        }
      } else if (commitRes.value.status === 403) {
        commitApiError = 'محدودیت موقت تعداد درخواست‌های API گیتهاب (Rate Limit) فعال شده است؛ چند دقیقه بعد دوباره تلاش کنید.';
      } else {
        commitApiError = `خطای ارتباط با گیتهاب (کد ${commitRes.value.status})`;
      }
    } else {
      commitApiError = 'اتصال به گیتهاب برقرار نشد. وضعیت اینترنت سرور را بررسی کنید.';
    }

    // If all three remote checks failed, return error state
    if (!latestReleaseTag && !remotePkgVersion && !latestCommit) {
      return {
        status: 'error',
        checkedAt,
        repo: local.repo,
        branch: local.branch,
        currentVersion: local.version,
        currentCommit: local.commitSha,
        latestVersion: null,
        latestReleaseTag: null,
        latestReleaseUrl: null,
        latestReleaseNotes: null,
        latestCommit: null,
        commitsBehind: null,
        summary: commitApiError || 'امکان بررسی نسخه جدید از گیتهاب وجود نداشت.',
        updateCommand,
        fallbackUpdateCommand,
        error: commitApiError || 'خطا در اتصال به گیتهاب',
      };
    }

    // Determine best remote version string
    let latestVersion: string | null = null;
    if (latestReleaseTag && remotePkgVersion) {
      const cmp = compareSemver(latestReleaseTag, remotePkgVersion);
      latestVersion = cmp !== null && cmp >= 0 ? latestReleaseTag : remotePkgVersion;
    } else {
      latestVersion = latestReleaseTag || remotePkgVersion;
    }

    // Optional commit comparison when both local and remote SHAs exist
    let commitsBehind: number | null = null;
    if (local.commitSha && latestCommit && local.commitSha !== latestCommit.shortSha) {
      try {
        const cmpRes = await fetch(
          `https://api.github.com/repos/${local.repo}/compare/${encodeURIComponent(local.commitSha)}...${encodeURIComponent(latestCommit.sha)}`,
          {
            headers,
            signal: AbortSignal.timeout(6000),
          },
        );
        if (cmpRes.ok) {
          const cmpData = (await cmpRes.json()) as {
            ahead_by?: number;
            behind_by?: number;
            status?: string;
          };
          if (typeof cmpData.ahead_by === 'number') {
            commitsBehind = cmpData.ahead_by;
          }
        }
      } catch {
        // Non-fatal
      }
    } else if (local.commitSha && latestCommit && local.commitSha === latestCommit.shortSha) {
      commitsBehind = 0;
    }

    // Determine final status & human-readable Persian summary
    let status: UpdateCheckResult['status'] = 'up_to_date';
    let summary = `سکان کاملاً به‌روز است (نسخه v${local.version}).`;

    const versionCmp = latestVersion ? compareSemver(latestVersion, local.version) : null;

    if (versionCmp !== null && versionCmp > 0) {
      status = 'update_available';
      summary = `نسخه جدیدتر v${latestVersion} در مخزن گیتهاب منتشر شده است (نسخه فعلی شما: v${local.version}). برای بروزرسانی دستور زیر را در سرور اجرا کنید.`;
    } else if (versionCmp !== null && versionCmp < 0) {
      status = 'ahead';
      summary = `نسخه فعلی شما (v${local.version}) جدیدتر از آخرین نسخه ثبت‌شده در گیتهاب (v${latestVersion}) است.`;
    } else if (commitsBehind !== null && commitsBehind > 0) {
      status = 'update_available';
      summary = `${commitsBehind} کامیت جدید روی شاخه ${local.branch} در گیتهاب ثبت شده است (آخرین کامیت: ${latestCommit?.shortSha ?? ''}). برای دریافت تغییرات می‌توانید آپدیت کنید.`;
    } else if (versionCmp === 0) {
      status = 'up_to_date';
      summary = `شما از آخرین نسخه پایدار سکان (v${local.version}) استفاده می‌کنید و نیازی به بروزرسانی نیست.`;
    } else if (latestCommit) {
      status = 'up_to_date';
      summary = `اتصال به مخزن برقرار شد. آخرین کامیت شاخه ${local.branch}: ${latestCommit.shortSha}.`;
    }

    return {
      status,
      checkedAt,
      repo: local.repo,
      branch: local.branch,
      currentVersion: local.version,
      currentCommit: local.commitSha,
      latestVersion,
      latestReleaseTag,
      latestReleaseUrl,
      latestReleaseNotes,
      latestCommit,
      commitsBehind,
      summary,
      updateCommand,
      fallbackUpdateCommand,
    };
  } catch (err) {
    const msg =
      err instanceof Error && err.name === 'TimeoutError'
        ? 'مهلت اتصال به گیتهاب به پایان رسید. دسترسی اینترنت سرور را بررسی کنید.'
        : 'خطا در بررسی بروزرسانی از گیتهاب.';
    return {
      status: 'error',
      checkedAt,
      repo: local.repo,
      branch: local.branch,
      currentVersion: local.version,
      currentCommit: local.commitSha,
      latestVersion: null,
      latestReleaseTag: null,
      latestReleaseUrl: null,
      latestReleaseNotes: null,
      latestCommit: null,
      commitsBehind: null,
      summary: msg,
      updateCommand,
      fallbackUpdateCommand,
      error: msg,
    };
  }
}
