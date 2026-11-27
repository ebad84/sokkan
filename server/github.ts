import { parse as parseYaml } from 'yaml';

export interface ParsedGitHubRepo {
  owner: string;
  repo: string;
  canonicalUrl: string;
}

export function parseGitHubRepoUrl(rawUrl: string): ParsedGitHubRepo {
  const trimmed = rawUrl.trim().replace(/\.git$/i, '');
  let match = trimmed.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/);
  if (!match) {
    match = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  }
  if (!match) {
    throw new Error('آدرس مخزن باید به شکل https://github.com/owner/repo یا owner/repo باشد.');
  }
  const owner = match[1];
  const repo = match[2];
  return {
    owner,
    repo,
    canonicalUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

export function validateBranchName(branch: string): string {
  const trimmed = branch.trim() || 'main';
  if (trimmed.startsWith('-') || trimmed.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(trimmed)) {
    throw new Error('نام شاخه گیت نامعتبر است.');
  }
  return trimmed;
}

function githubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Sokkan-PaaS',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function fetchRepoFileText(
  owner: string,
  repo: string,
  filePath: string,
  branch: string,
  token?: string,
): Promise<string | null> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: githubHeaders(token), signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as { content?: string; encoding?: string };
  if (data.content && data.encoding === 'base64') {
    return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
  }
  return null;
}

export interface ComposeServiceInfo {
  name: string;
  ports: number[];
  hasBuild: boolean;
  image?: string;
}

export interface GitHubInspectionResult {
  owner: string;
  repo: string;
  canonicalUrl: string;
  defaultBranch: string;
  isPrivate: boolean;
  description: string;
  latestCommit: {
    sha: string;
    shortSha: string;
    message: string;
    author: string;
    date: string;
  } | null;
  detectedBuildMode: 'dockerfile' | 'compose' | 'unknown';
  detectedBuildFile: string;
  detectedPorts: number[];
  composeServices: ComposeServiceInfo[];
  envExampleKeys: string[];
  rootFiles: string[];
}

function extractExposePortsFromDockerfile(content: string): number[] {
  const ports: number[] = [];
  for (const line of content.split('\n')) {
    const clean = line.trim();
    if (/^EXPOSE\s+/i.test(clean)) {
      const rest = clean.replace(/^EXPOSE\s+/i, '');
      for (const token of rest.split(/\s+/)) {
        const num = Number(token.split('/')[0]);
        if (Number.isInteger(num) && num > 0 && num <= 65535) {
          ports.push(num);
        }
      }
    }
  }
  return Array.from(new Set(ports));
}

function extractComposeInfo(content: string): { services: ComposeServiceInfo[]; ports: number[] } {
  const services: ComposeServiceInfo[] = [];
  const allPorts: number[] = [];
  try {
    const parsed = parseYaml(content) as {
      services?: Record<
        string,
        {
          ports?: Array<string | number | { target?: number; published?: number }>;
          expose?: Array<string | number>;
          build?: unknown;
          image?: string;
        }
      >;
    };
    if (parsed?.services && typeof parsed.services === 'object') {
      for (const [svcName, svcDef] of Object.entries(parsed.services)) {
        const svcPorts: number[] = [];
        for (const p of svcDef.ports ?? []) {
          if (typeof p === 'number') {
            svcPorts.push(p);
          } else if (typeof p === 'string') {
            const parts = p.split(':');
            const target = Number(parts[parts.length - 1].split('/')[0]);
            if (Number.isInteger(target) && target > 0) svcPorts.push(target);
          } else if (p && typeof p === 'object' && typeof p.target === 'number') {
            svcPorts.push(p.target);
          }
        }
        for (const e of svcDef.expose ?? []) {
          const num = Number(String(e).split('/')[0]);
          if (Number.isInteger(num) && num > 0) svcPorts.push(num);
        }
        const unique = Array.from(new Set(svcPorts));
        allPorts.push(...unique);
        services.push({
          name: svcName,
          ports: unique,
          hasBuild: Boolean(svcDef.build),
          image: svcDef.image,
        });
      }
    }
  } catch {
    // Ignore YAML parse issues and let user configure port manually
  }
  return { services, ports: Array.from(new Set(allPorts)) };
}

function extractEnvKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const k = trimmed.slice(0, eqIdx).trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        keys.push(k);
      }
    }
  }
  return Array.from(new Set(keys));
}

export async function fetchLatestGitHubCommit(
  repoUrl: string,
  branch: string,
  token?: string,
): Promise<{ sha: string; shortSha: string; message: string; author: string; date: string } | null> {
  const { owner, repo } = parseGitHubRepoUrl(repoUrl);
  const safeBranch = validateBranchName(branch);
  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(safeBranch)}`,
    { headers: githubHeaders(token), signal: AbortSignal.timeout(10000) },
  );
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as {
    sha?: string;
    commit?: { message?: string; author?: { name?: string; date?: string } };
  };
  if (!data.sha) return null;
  return {
    sha: data.sha,
    shortSha: data.sha.slice(0, 7),
    message: (data.commit?.message ?? '').split('\n')[0],
    author: data.commit?.author?.name ?? '',
    date: data.commit?.author?.date ?? '',
  };
}

export async function inspectGitHubRepo(
  repoUrl: string,
  requestedBranch?: string,
  token?: string,
): Promise<GitHubInspectionResult> {
  const { owner, repo, canonicalUrl } = parseGitHubRepoUrl(repoUrl);
  const headers = githubHeaders(token);

  const repoRes = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { headers, signal: AbortSignal.timeout(10000) },
  );
  if (!repoRes.ok) {
    if (repoRes.status === 404) {
      throw new Error('مخزن در گیتهاب پیدا نشد (اگر مخزن خصوصی است، توکن دسترسی گیتهاب را وارد کنید).');
    }
    if (repoRes.status === 401 || repoRes.status === 403) {
      throw new Error('دسترسی به گیتهاب مجاز نیست یا محدودیت درخواست (Rate Limit) اعمال شده است.');
    }
    throw new Error(`خطای ارتباط با API گیتهاب (کد ${repoRes.status})`);
  }

  const repoMeta = (await repoRes.json()) as {
    default_branch?: string;
    private?: boolean;
    description?: string | null;
  };

  const targetBranch = validateBranchName(requestedBranch || repoMeta.default_branch || 'main');

  const contentsRes = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents?ref=${encodeURIComponent(targetBranch)}`,
    { headers, signal: AbortSignal.timeout(10000) },
  );
  const rootItems = contentsRes.ok
    ? ((await contentsRes.json()) as Array<{ name: string; type: string }>)
    : [];
  const rootFiles = Array.isArray(rootItems) ? rootItems.map((i) => i.name) : [];

  const composeCandidate = rootFiles.find((f) =>
    ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].includes(f),
  );
  const hasDockerfile = rootFiles.includes('Dockerfile');

  let detectedBuildMode: 'dockerfile' | 'compose' | 'unknown' = 'unknown';
  let detectedBuildFile = 'Dockerfile';
  let detectedPorts: number[] = [];
  let composeServices: ComposeServiceInfo[] = [];

  if (composeCandidate) {
    detectedBuildMode = 'compose';
    detectedBuildFile = composeCandidate;
    const composeText = await fetchRepoFileText(owner, repo, composeCandidate, targetBranch, token);
    if (composeText) {
      const info = extractComposeInfo(composeText);
      composeServices = info.services;
      detectedPorts = info.ports;
    }
  }

  if (hasDockerfile) {
    if (detectedBuildMode === 'unknown') {
      detectedBuildMode = 'dockerfile';
      detectedBuildFile = 'Dockerfile';
    }
    const dockerfileText = await fetchRepoFileText(owner, repo, 'Dockerfile', targetBranch, token);
    if (dockerfileText) {
      const dfPorts = extractExposePortsFromDockerfile(dockerfileText);
      detectedPorts = Array.from(new Set([...detectedPorts, ...dfPorts]));
    }
  }

  const envCandidate = rootFiles.find((f) => f === '.env.example' || f === '.env.sample');
  let envExampleKeys: string[] = [];
  if (envCandidate) {
    const envText = await fetchRepoFileText(owner, repo, envCandidate, targetBranch, token);
    if (envText) {
      envExampleKeys = extractEnvKeys(envText);
    }
  }

  const latestCommit = await fetchLatestGitHubCommit(canonicalUrl, targetBranch, token);

  return {
    owner,
    repo,
    canonicalUrl,
    defaultBranch: targetBranch,
    isPrivate: Boolean(repoMeta.private),
    description: repoMeta.description ?? '',
    latestCommit,
    detectedBuildMode,
    detectedBuildFile,
    detectedPorts: detectedPorts.length > 0 ? detectedPorts : [3000],
    composeServices,
    envExampleKeys,
    rootFiles: rootFiles.slice(0, 40),
  };
}
