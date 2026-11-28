import {
  Check,
  Copy,
  GitBranch,
  Globe,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { apiFetch, streamDeploymentLogs } from '../api';
import { GitHubAppPanel, GitHubRepoPicker } from './GitHubAppPanel';
import type {
  Deployment,
  GitHubAppRepo,
  GitHubAppStatus,
  GitHubInspectionResult,
  PrivateNetwork,
  Project,
} from '../types';

function extractOwnerRepoFromUrl(rawUrl: string): { owner: string; repo: string } | null {
  const trimmed = rawUrl.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!trimmed) return null;
  const normalized = trimmed
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0].trim().toLowerCase(), repo: parts[1].trim().toLowerCase() };
}

function buildSampleActionsWorkflow(opts: {
  branch: string;
  buildMode: 'dockerfile' | 'compose';
  buildFilePath: string;
  ghcrImage: string;
  repoUrl: string;
}): string {
  const parsed = extractOwnerRepoFromUrl(opts.repoUrl);
  const defaultImg = parsed
    ? `ghcr.io/${parsed.owner}/${parsed.repo}:latest`
    : 'ghcr.io/OWNER/REPO:latest';
  const imageRef = opts.ghcrImage.trim() || defaultImg;
  const branch = opts.branch.trim() || 'main';
  if (opts.buildMode === 'compose') {
    return `name: Build & Deploy to Sokkan

on:
  push:
    branches: [${branch}]
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
      # ایمیج‌های سرویس‌های خود را بسازید و روی GHCR پوش کنید
      # سپس docker-compose.ghcr.yml باید از همان ایمیج‌ها با pull_policy: always استفاده کند
      - name: Trigger Sokkan Deploy
        if: \${{ secrets.SOKKAN_WEBHOOK_URL != '' && secrets.SOKKAN_WEBHOOK_SECRET != '' }}
        env:
          WEBHOOK_URL: \${{ secrets.SOKKAN_WEBHOOK_URL }}
          WEBHOOK_SECRET: \${{ secrets.SOKKAN_WEBHOOK_SECRET }}
        run: |
          BODY="{\"ref\":\"refs/heads/\${GITHUB_REF_NAME}\",\"source\":\"github_actions\",\"sha\":\"\${GITHUB_SHA}\"}"
          SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | awk '{print $NF}')"
          curl -fsS -X POST "$WEBHOOK_URL" \
            -H "Content-Type: application/json" \
            -H "X-GitHub-Event: github_actions_deploy" \
            -H "X-Hub-Signature-256: $SIG" \
            -d "$BODY"`;
  }
  const dockerfile = opts.buildFilePath.trim() || 'Dockerfile';
  return `name: Build & Deploy to Sokkan

on:
  push:
    branches: [${branch}]
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: ${dockerfile}
          push: true
          tags: ${imageRef}
          cache-from: type=gha
          cache-to: type=gha,mode=max
      - name: Trigger Sokkan Deploy
        if: \${{ secrets.SOKKAN_WEBHOOK_URL != '' && secrets.SOKKAN_WEBHOOK_SECRET != '' }}
        env:
          WEBHOOK_URL: \${{ secrets.SOKKAN_WEBHOOK_URL }}
          WEBHOOK_SECRET: \${{ secrets.SOKKAN_WEBHOOK_SECRET }}
        run: |
          BODY="{\"ref\":\"refs/heads/\${GITHUB_REF_NAME}\",\"source\":\"github_actions\",\"sha\":\"\${GITHUB_SHA}\"}"
          SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | awk '{print $NF}')"
          curl -fsS -X POST "$WEBHOOK_URL" \
            -H "Content-Type: application/json" \
            -H "X-GitHub-Event: github_actions_deploy" \
            -H "X-Hub-Signature-256: $SIG" \
            -d "$BODY"`;
}

function extractRepoNameFromUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!trimmed) return '';
  // Accept https://github.com/owner/repo, git@github.com:owner/repo, or owner/repo
  const normalized = trimmed
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 2) return '';
  return parts[1].trim();
}

function toContainerSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseBulkEnvText(raw: string): Array<{ key: string; value: string }> {
  const rows: Array<{ key: string; value: string }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      rows.push({ key, value });
    }
  }
  return rows;
}

interface DeploymentDrawerProps {
  deploymentId: string | null;
  projects: Project[];
  onClose: () => void;
  onDeploymentFinished: () => void;
}

export function DeploymentDrawer({
  deploymentId,
  projects,
  onClose,
  onDeploymentFinished,
}: DeploymentDrawerProps) {
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [logs, setLogs] = useState('');
  const [status, setStatus] = useState<string>('building');
  const [error, setError] = useState('');
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!deploymentId) return;
    setError('');
    setLogs('');

    let stopStream: (() => void) | undefined;

    const init = async () => {
      try {
        const dep = await apiFetch<Deployment>(`/api/deployments/${encodeURIComponent(deploymentId)}`);
        setDeployment(dep);
        setLogs(dep.logs);
        setStatus(dep.status);

        if (dep.status === 'building') {
          stopStream = streamDeploymentLogs(deploymentId, {
            onInit: (initLogs, initStatus) => {
              setLogs(initLogs);
              setStatus(initStatus);
            },
            onChunk: (chunk) => {
              setLogs((prev) => prev + chunk);
            },
            onDone: (finalStatus) => {
              setStatus(finalStatus);
              onDeploymentFinished();
            },
            onError: (msg) => setError(msg),
          });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'خطا در دریافت اطلاعات دیپلوی');
      }
    };

    void init();
    return () => {
      if (stopStream) stopStream();
    };
  }, [deploymentId, onDeploymentFinished]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  if (!deploymentId) return null;

  const project = deployment ? projects.find((p) => p.id === deployment.project_id) : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="w-full max-w-4xl bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden flex flex-col max-h-[88vh]">
        <div className="px-5 py-4 border-b border-[#1F2937] flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <Terminal className="w-4 h-4 text-sky-400" />
              <span>لاگ پایپ‌لاین دیپلوی</span>
              {project && <span className="text-slate-400">· {project.name}</span>}
            </div>
            <div className="text-xs text-slate-400 flex items-center gap-2">
              <span
                className={
                  status === 'success'
                    ? 'text-emerald-400 font-medium'
                    : status === 'failed'
                      ? 'text-red-400 font-medium'
                      : 'text-amber-400 font-medium'
                }
              >
                {status === 'success'
                  ? 'موفق'
                  : status === 'failed'
                    ? 'ناموفق'
                    : 'در حال اجرا...'}
              </span>
              {deployment?.commit_sha && (
                <>
                  <span>·</span>
                  <span className="font-mono tabular-nums">{deployment.commit_sha.slice(0, 7)}</span>
                </>
              )}
              {deployment && (
                <>
                  <span>·</span>
                  <span>
                    {deployment.execution_mode === 'vps'
                      ? 'اجرای واقعی روی VPS'
                      : 'حالت پیش‌نمایش (بدون داکر)'}
                  </span>
                </>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-100 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="px-5 py-2.5 bg-red-500/10 border-b border-red-500/20 text-xs text-red-400">
            {error}
          </div>
        )}

        <pre className="p-5 bg-[#0B0F17] text-xs font-mono text-slate-200 overflow-auto flex-1 whitespace-pre-wrap leading-relaxed">
          {logs || 'در انتظار خروجی پایپ‌لاین...'}
          <div ref={logEndRef} />
        </pre>
      </div>
    </div>
  );
}

interface ProjectsPageProps {
  projects: Project[];
  deployments: Deployment[];
  networks: PrivateNetwork[];
  isAdmin: boolean;
  openAddModalTrigger: number;
  onRefresh: () => void;
  onInspectDeployment: (deploymentId: string) => void;
}

export function ProjectsPage({
  projects,
  deployments,
  networks,
  isAdmin,
  openAddModalTrigger,
  onRefresh,
  onInspectDeployment,
}: ProjectsPageProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'building' | 'error'>('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [deployingId, setDeployingId] = useState<string | null>(null);

  // GitHub App one-click integration state
  const [ghAppStatus, setGhAppStatus] = useState<GitHubAppStatus | null>(null);
  const [ghAppRepos, setGhAppRepos] = useState<GitHubAppRepo[]>([]);
  const [loadingGhRepos, setLoadingGhRepos] = useState(false);

  // Add project form state
  const [repoUrl, setRepoUrl] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [selectedInstallationId, setSelectedInstallationId] = useState(0);
  const [selectedRepoFullName, setSelectedRepoFullName] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [inspectResult, setInspectResult] = useState<GitHubInspectionResult | null>(null);
  const [inspectError, setInspectError] = useState('');

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);
  const [branch, setBranch] = useState('main');
  const [buildMode, setBuildMode] = useState<'dockerfile' | 'compose'>('dockerfile');
  const [deployStrategy, setDeployStrategy] = useState<'local' | 'github_actions'>('local');
  const [ghcrImage, setGhcrImage] = useState('');
  const [actionsComposeFile, setActionsComposeFile] = useState('docker-compose.ghcr.yml');
  const [buildFilePath, setBuildFilePath] = useState('Dockerfile');
  const [containerPort, setContainerPort] = useState(3000);
  const [domain, setDomain] = useState('');
  const [privateNetworkId, setPrivateNetworkId] = useState('');
  const [caddyEnabled, setCaddyEnabled] = useState(true);
  const [autoDeployWebhook, setAutoDeployWebhook] = useState(true);
  const [pollingIntervalSec, setPollingIntervalSec] = useState(300);
  const [envRows, setEnvRows] = useState<Array<{ key: string; value: string }>>([]);
  const [creating, setCreating] = useState(false);

  // Created webhook secret banner
  const [createdWebhookInfo, setCreatedWebhookInfo] = useState<{
    projectId: string;
    projectName: string;
    secret: string;
    usedGithubApp?: boolean;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Edit project modal state
  const [editDomain, setEditDomain] = useState('');
  const [editPort, setEditPort] = useState(3000);
  const [editBranch, setEditBranch] = useState('main');
  const [editDeployStrategy, setEditDeployStrategy] = useState<'local' | 'github_actions'>('local');
  const [editGhcrImage, setEditGhcrImage] = useState('');
  const [editActionsComposeFile, setEditActionsComposeFile] = useState('');
  const [editGithubToken, setEditGithubToken] = useState('');
  const [editPrivateNetworkId, setEditPrivateNetworkId] = useState('');
  const [editPolling, setEditPolling] = useState(300);
  const [editWebhook, setEditWebhook] = useState(true);
  const [editCaddyEnabled, setEditCaddyEnabled] = useState(true);
  const [editExtraDirectives, setEditExtraDirectives] = useState('');
  const [editEnvKey, setEditEnvKey] = useState('');
  const [editEnvVal, setEditEnvVal] = useState('');
  const [editBulkEnv, setEditBulkEnv] = useState('');
  const [editDeletedEnvKeys, setEditDeletedEnvKeys] = useState<string[]>([]);
  const [showBulkEnvAdd, setShowBulkEnvAdd] = useState(false);
  const [bulkEnvAddText, setBulkEnvAddText] = useState('');
  const [editRotatedSecret, setEditRotatedSecret] = useState('');
  const [editError, setEditError] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const loadGitHubAppRepos = useCallback(async () => {
    setLoadingGhRepos(true);
    try {
      const data = await apiFetch<{ repos: GitHubAppRepo[] }>('/api/github/app/repos');
      setGhAppRepos(data.repos ?? []);
    } catch {
      setGhAppRepos([]);
    } finally {
      setLoadingGhRepos(false);
    }
  }, []);

  const loadGitHubAppStatus = useCallback(async () => {
    try {
      const st = await apiFetch<GitHubAppStatus>('/api/github/app/status');
      setGhAppStatus(st);
      if (st.connected && st.installed) {
        void loadGitHubAppRepos();
      } else {
        setGhAppRepos([]);
      }
    } catch {
      setGhAppStatus(null);
    }
  }, [loadGitHubAppRepos]);

  useEffect(() => {
    void loadGitHubAppStatus();
  }, [loadGitHubAppStatus]);

  useEffect(() => {
    if (openAddModalTrigger > 0) {
      setShowAddModal(true);
    }
  }, [openAddModalTrigger]);

  const copyText = (key: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  const inspectRepoWithParams = async (
    targetUrl: string,
    targetBranch?: string,
    installationId?: number,
    preserveNames = false,
  ) => {
    setInspecting(true);
    setInspectError('');
    setInspectResult(null);
    try {
      const res = await apiFetch<
        GitHubInspectionResult & { authSource?: string; installationId?: number }
      >('/api/github/inspect', {
        method: 'POST',
        body: JSON.stringify({
          repoUrl: targetUrl,
          branch: targetBranch?.trim() || undefined,
          githubToken: githubToken.trim() || undefined,
          installationId: installationId || selectedInstallationId || undefined,
        }),
      });
      setInspectResult(res);
      if (res.installationId && res.installationId > 0) {
        setSelectedInstallationId(res.installationId);
      }
      if (!preserveNames) {
        if (!nameTouched || !name.trim()) setName(res.repo);
        if (!slugTouched || !slug.trim()) {
          setSlug(toContainerSlug(res.repo));
        }
      }
      setBranch(res.defaultBranch);
      setBuildMode(res.detectedBuildMode === 'compose' ? 'compose' : 'dockerfile');
      setBuildFilePath(res.detectedBuildFile || 'Dockerfile');
      if (res.owner && res.repo) {
        setGhcrImage(`ghcr.io/${res.owner.toLowerCase()}/${res.repo.toLowerCase()}:latest`);
      }
      if (res.rootFiles.includes('docker-compose.ghcr.yml')) {
        setActionsComposeFile('docker-compose.ghcr.yml');
      }
      if (res.detectedPorts.length > 0) {
        setContainerPort(res.detectedPorts[0]);
      }
      if (res.envExampleKeys.length > 0) {
        setEnvRows(res.envExampleKeys.map((k) => ({ key: k, value: '' })));
      }
    } catch (err) {
      setInspectError(err instanceof Error ? err.message : 'خطا در بررسی مخزن گیتهاب');
    } finally {
      setInspecting(false);
    }
  };

  const handleInspectRepo = async () => {
    await inspectRepoWithParams(repoUrl, branch, selectedInstallationId);
  };

  const handleSelectAppRepo = (repo: GitHubAppRepo) => {
    setSelectedRepoFullName(repo.fullName);
    setSelectedInstallationId(repo.installationId);
    setRepoUrl(repo.htmlUrl || `https://github.com/${repo.fullName}`);
    setBranch(repo.defaultBranch || 'main');
    setName(repo.name);
    setSlug(toContainerSlug(repo.name));
    setNameTouched(false);
    setSlugTouched(false);
    setGhcrImage(`ghcr.io/${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}:latest`);
    void inspectRepoWithParams(
      repo.htmlUrl || `https://github.com/${repo.fullName}`,
      repo.defaultBranch,
      repo.installationId,
      true,
    );
  };

  const resetAddForm = () => {
    setRepoUrl('');
    setGithubToken('');
    setSelectedInstallationId(0);
    setSelectedRepoFullName('');
    setInspectResult(null);
    setInspectError('');
    setName('');
    setSlug('');
    setNameTouched(false);
    setSlugTouched(false);
    setBranch('main');
    setBuildMode('dockerfile');
    setDeployStrategy('local');
    setGhcrImage('');
    setActionsComposeFile('docker-compose.ghcr.yml');
    setBuildFilePath('Dockerfile');
    setContainerPort(3000);
    setDomain('');
    setPrivateNetworkId('');
    setCaddyEnabled(true);
    setAutoDeployWebhook(true);
    setPollingIntervalSec(300);
    setEnvRows([]);
  };

  const handleCreateProject = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setInspectError('');
    try {
      const envVars: Record<string, string> = {};
      for (const row of envRows) {
        if (row.key.trim() && row.value !== '') {
          envVars[row.key.trim()] = row.value;
        }
      }

      const usedGithubApp = Boolean(selectedInstallationId > 0 && !githubToken.trim());
      const res = await apiFetch<{
        project: Project;
        generatedWebhookSecret: string;
        caddyWarning?: string;
      }>(
        '/api/projects',
        {
          method: 'POST',
          body: JSON.stringify({
            name,
            slug,
            repoUrl,
            branch,
            buildMode,
            deployStrategy,
            ghcrImage,
            actionsComposeFile,
            buildFilePath,
            containerPort,
            domain,
            privateNetworkId: privateNetworkId || null,
            caddyEnabled,
            autoDeployWebhook,
            pollingIntervalSec,
            githubToken,
            githubInstallationId: selectedInstallationId || 0,
            envVars,
            lastCommitSha: inspectResult?.latestCommit?.sha ?? '',
            lastCommitMsg: inspectResult?.latestCommit?.message ?? '',
          }),
        },
      );

      setShowAddModal(false);
      resetAddForm();
      if (res.caddyWarning) {
        setActionError(`پروژه ثبت شد اما هشدار Caddy رخ داد: ${res.caddyWarning}`);
      }
      setCreatedWebhookInfo({
        projectId: res.project.id,
        projectName: res.project.name,
        secret: res.generatedWebhookSecret,
        usedGithubApp,
      });
      onRefresh();
    } catch (err) {
      setInspectError(err instanceof Error ? err.message : 'خطا در ثبت پروژه');
    } finally {
      setCreating(false);
    }
  };

  const handleDeploy = async (projectId: string) => {
    setDeployingId(projectId);
    setActionError('');
    try {
      const dep = await apiFetch<Deployment>(`/api/projects/${encodeURIComponent(projectId)}/deploy`, {
        method: 'POST',
      });
      onRefresh();
      onInspectDeployment(dep.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'خطا در شروع دیپلوی');
    } finally {
      setDeployingId(null);
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    setActionError('');
    try {
      await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'حذف پروژه ناموفق بود');
    }
  };

  const openEditModal = (p: Project) => {
    setEditingProject(p);
    setEditDomain(p.domain);
    setEditPort(p.containerPort);
    setEditBranch(p.branch);
    setEditDeployStrategy(p.deployStrategy === 'github_actions' ? 'github_actions' : 'local');
    setEditGhcrImage(p.ghcrImage || '');
    setEditActionsComposeFile(p.actionsComposeFile || '');
    setEditGithubToken('');
    setEditPrivateNetworkId(p.privateNetworkId ?? '');
    setEditPolling(p.pollingIntervalSec);
    setEditWebhook(p.autoDeployWebhook);
    setEditCaddyEnabled(p.caddyEnabled);
    setEditExtraDirectives(p.caddyExtraDirectives);
    setEditEnvKey('');
    setEditEnvVal('');
    setEditBulkEnv('');
    setEditDeletedEnvKeys([]);
    setEditRotatedSecret('');
    setEditError('');
  };

  const handleSaveEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingProject) return;
    setSavingEdit(true);
    setEditError('');
    setActionError('');
    try {
      const envUpdate: Record<string, string | null> = {};
      for (const delKey of editDeletedEnvKeys) {
        envUpdate[delKey] = null;
      }
      for (const row of parseBulkEnvText(editBulkEnv)) {
        envUpdate[row.key] = row.value;
      }
      if (editEnvKey.trim() && editEnvVal !== '') {
        envUpdate[editEnvKey.trim()] = editEnvVal;
      }

      const updated = await apiFetch<Project & { caddyWarning?: string }>(
        `/api/projects/${encodeURIComponent(editingProject.id)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            domain: editDomain,
            containerPort: editPort,
            branch: editBranch,
            deployStrategy: editDeployStrategy,
            ghcrImage: editGhcrImage,
            actionsComposeFile: editActionsComposeFile,
            ...(editGithubToken.trim() ? { githubToken: editGithubToken.trim() } : {}),
            privateNetworkId: editPrivateNetworkId || null,
            pollingIntervalSec: editPolling,
            autoDeployWebhook: editWebhook,
            caddyEnabled: editCaddyEnabled,
            ...(isAdmin ? { caddyExtraDirectives: editExtraDirectives } : {}),
            envVars: Object.keys(envUpdate).length > 0 ? envUpdate : undefined,
          }),
        },
      );
      if (updated.caddyWarning) {
        setActionError(`تنظیمات پروژه ذخیره شد اما هشدار Caddy رخ داد: ${updated.caddyWarning}`);
      }
      setEditingProject(null);
      onRefresh();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'خطا در ذخیره تغییرات');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleRotateSecret = async () => {
    if (!editingProject) return;
    setEditError('');
    try {
      const res = await apiFetch<{ webhookSecret: string }>(
        `/api/projects/${encodeURIComponent(editingProject.id)}/rotate-webhook`,
        { method: 'POST' },
      );
      setEditRotatedSecret(res.webhookSecret);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'خطا در تولید کلید جدید');
    }
  };

  const filtered = projects.filter((p) => {
    const q = search.trim().toLowerCase();
    const matchSearch =
      !q ||
      p.name.toLowerCase().includes(q) ||
      p.slug.toLowerCase().includes(q) ||
      p.repoUrl.toLowerCase().includes(q) ||
      p.domain.toLowerCase().includes(q);
    const matchStatus = statusFilter === 'all' || p.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const webhookOrigin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div className="space-y-6">
      <GitHubAppPanel
        isAdmin={isAdmin}
        status={ghAppStatus}
        repos={ghAppRepos}
        loadingRepos={loadingGhRepos}
        onStatusChanged={() => {
          void loadGitHubAppStatus();
        }}
        onQuickAddProject={() => setShowAddModal(true)}
      />

      {createdWebhookInfo && (
        <div
          className={`bg-[#111827] border rounded-xl p-5 space-y-3 ${
            createdWebhookInfo.usedGithubApp ? 'border-emerald-500/40' : 'border-sky-500/40'
          }`}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-100">
              {createdWebhookInfo.usedGithubApp
                ? `پروژه «${createdWebhookInfo.projectName}» از طریق GitHub App متصل شد`
                : `تنظیمات GitHub Webhook برای «${createdWebhookInfo.projectName}»`}
            </h3>
            <button
              type="button"
              onClick={() => setCreatedWebhookInfo(null)}
              className="text-slate-400 hover:text-slate-100 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed">
            {createdWebhookInfo.usedGithubApp
              ? 'وب‌هوک خودکار GitHub App (برای Push و اتمام GitHub Actions) از قبل برای این مخزن فعال است و نیازی به تنظیم دستی در گیتهاب ندارید. مقادیر زیر فقط در صورت نیاز به تریگر سفارشی در Workflow ذخیره شده‌اند:'
              : 'برای دیپلوی آنی پس از هر Push، مقادیر زیر را در بخش Settings ← Webhooks مخزن گیتهاب وارد کنید (Content type: application/json):'}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div className="bg-[#0B0F17] border border-[#1F2937] rounded-lg p-3 flex items-center justify-between gap-2">
              <div className="truncate font-mono text-sky-400">
                {webhookOrigin}/api/webhooks/github/{createdWebhookInfo.projectId}
              </div>
              <button
                type="button"
                onClick={() =>
                  copyText(
                    'wh-url',
                    `${webhookOrigin}/api/webhooks/github/${createdWebhookInfo.projectId}`,
                  )
                }
                className="text-slate-400 hover:text-slate-100 shrink-0 cursor-pointer"
              >
                {copiedKey === 'wh-url' ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
            <div className="bg-[#0B0F17] border border-[#1F2937] rounded-lg p-3 flex items-center justify-between gap-2">
              <div className="truncate font-mono text-emerald-400">
                Secret: {createdWebhookInfo.secret}
              </div>
              <button
                type="button"
                onClick={() => copyText('wh-sec', createdWebhookInfo.secret)}
                className="text-slate-400 hover:text-slate-100 shrink-0 cursor-pointer"
              >
                {copiedKey === 'wh-sec' ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>
      )}

      {actionError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-xs text-red-400">
          {actionError}
        </div>
      )}

      {/* Filter & Toolbar */}
      <div className="bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden">
        <div className="p-4 border-b border-[#1F2937] flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-xs">
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="جستجو نام، دامنه یا مخزن..."
                className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg pr-9 pl-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-500"
              />
            </div>

            <div className="flex items-center gap-1 p-1 bg-[#0B0F17] border border-[#1F2937] rounded-lg">
              {(
                [
                  { id: 'all', label: 'همه' },
                  { id: 'running', label: 'فعال' },
                  { id: 'building', label: 'در حال ساخت' },
                  { id: 'error', label: 'خطا' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setStatusFilter(tab.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                    statusFilter === tab.id
                      ? 'bg-[#1F2937] text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="px-4 py-2 text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap self-start"
          >
            <Plus className="w-4 h-4" />
            اتصال مخزن جدید
          </button>
        </div>

        {filtered.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <p className="text-sm text-slate-400">
              {projects.length === 0
                ? 'هنوز هیچ مخزن گیتهابی متصل نشده است.'
                : 'پروژه‌ای مطابق فیلتر جستجو پیدا نشد.'}
            </p>
            {projects.length === 0 && (
              <button
                type="button"
                onClick={() => setShowAddModal(true)}
                className="px-4 py-2 text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 rounded-lg cursor-pointer"
              >
                افزودن اولین پروژه گیتهاب
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-[#1F2937]">
            {filtered.map((p) => {
              const latestDep = deployments.find((d) => d.project_id === p.id);
              const statusText =
                p.status === 'running'
                  ? 'در حال اجرا'
                  : p.status === 'building'
                    ? 'در حال بیلد'
                    : p.status === 'error'
                      ? 'خطای دیپلوی'
                      : 'آماده اولین دیپلوی';
              const statusClass =
                p.status === 'running'
                  ? 'text-emerald-400'
                  : p.status === 'building'
                    ? 'text-amber-400'
                    : p.status === 'error'
                      ? 'text-red-400'
                      : 'text-slate-400';

              return (
                <div
                  key={p.id}
                  className="p-5 hover:bg-slate-800/20 transition-colors flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                >
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <h3 className="text-sm font-semibold text-slate-100">{p.name}</h3>
                      <span className={`text-xs font-medium ${statusClass}`}>{statusText}</span>
                      <span
                        className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                          p.deployStrategy === 'github_actions'
                            ? 'bg-violet-500/10 text-violet-300 border-violet-500/30'
                            : 'bg-sky-500/10 text-sky-300 border-sky-500/25'
                        }`}
                      >
                        {p.deployStrategy === 'github_actions' ? 'GitHub Actions · GHCR' : 'VPS BuildKit'}
                      </span>
                    </div>

                    <div className="text-xs text-slate-400 flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-slate-300">{p.repoUrl.replace('https://github.com/', '')}</span>
                      <span>·</span>
                      <span className="inline-flex items-center gap-1 font-mono">
                        <GitBranch className="w-3 h-3" />
                        {p.branch}
                      </span>
                      <span>·</span>
                      <span className="font-mono">{p.buildMode === 'compose' ? p.buildFilePath : `Dockerfile:${p.containerPort}`}</span>
                      {p.domain && (
                        <>
                          <span>·</span>
                          <span className="inline-flex items-center gap-1 font-mono text-sky-400">
                            <Globe className="w-3 h-3" />
                            {p.domain}
                          </span>
                        </>
                      )}
                    </div>

                    <div className="text-[11px] text-slate-500 flex items-center gap-2 flex-wrap">
                      <span>
                        اتوماسیون:{' '}
                        {[
                          p.autoDeployWebhook ? 'Webhook' : null,
                          p.pollingIntervalSec > 0 ? `Polling هر ${p.pollingIntervalSec}s` : null,
                        ]
                          .filter(Boolean)
                          .join(' + ') || 'فقط دستی'}
                      </span>
                      {p.lastCommitSha && (
                        <>
                          <span>·</span>
                          <span className="font-mono tabular-nums">
                            آخرین کامیت: {p.lastCommitSha.slice(0, 7)}
                          </span>
                        </>
                      )}
                      {p.envKeys.length > 0 && (
                        <>
                          <span>·</span>
                          <span className="tabular-nums">{p.envKeys.length} متغیر Env</span>
                        </>
                      )}
                      {p.networks && p.networks.length > 0 && (
                        <>
                          <span>·</span>
                          <span className="text-sky-400">
                            شبکه خصوصی: {p.networks.map((n) => n.name).join('، ')}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 flex-wrap">
                    <button
                      type="button"
                      disabled={deployingId === p.id || p.status === 'building'}
                      onClick={() => handleDeploy(p.id)}
                      className="px-3.5 py-2 text-xs font-semibold bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      <Play className="w-3.5 h-3.5" />
                      {deployingId === p.id ? 'در حال شروع...' : 'دیپلوی دستی'}
                    </button>

                    {latestDep && (
                      <button
                        type="button"
                        onClick={() => onInspectDeployment(latestDep.id)}
                        className="px-3 py-2 text-xs font-medium text-slate-200 bg-[#0B0F17] border border-[#1F2937] hover:border-slate-600 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                      >
                        <Terminal className="w-3.5 h-3.5" />
                        لاگ بیلد
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => openEditModal(p)}
                      className="px-3 py-2 text-xs font-medium text-slate-200 bg-[#0B0F17] border border-[#1F2937] hover:border-slate-600 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      <Settings className="w-3.5 h-3.5" />
                      تنظیمات و Webhook
                    </button>

                    {confirmDeleteId === p.id ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleDeleteProject(p.id)}
                          className="px-3 py-2 text-xs font-medium bg-red-500 text-white rounded-lg cursor-pointer whitespace-nowrap"
                        >
                          تایید حذف
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="px-2.5 py-2 text-xs font-medium text-slate-300 bg-[#0B0F17] border border-[#1F2937] rounded-lg cursor-pointer whitespace-nowrap"
                        >
                          انصراف
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(p.id)}
                        title="حذف پروژه"
                        className="p-2 text-red-400 bg-[#0B0F17] border border-[#1F2937] hover:border-red-500/40 rounded-lg cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add Project Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-[#1F2937] flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-100">اتصال مخزن گیتهاب به CI/CD</h2>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateProject} className="p-6 overflow-y-auto space-y-5 text-xs">
              {/* Step 1: Repo Inspection */}
              <div className="space-y-3">
                {ghAppStatus?.connected && ghAppStatus.installed && (
                  <GitHubRepoPicker
                    repos={ghAppRepos}
                    loading={loadingGhRepos}
                    selectedFullName={selectedRepoFullName}
                    onSelect={handleSelectAppRepo}
                    onRefresh={() => {
                      void loadGitHubAppRepos();
                    }}
                  />
                )}

                <label className="block font-medium text-slate-200">
                  ۱. آدرس مخزن گیتهاب و بررسی خودکار Dockerfile / Compose
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    required
                    value={repoUrl}
                    onChange={(e) => {
                      const nextUrl = e.target.value;
                      setRepoUrl(nextUrl);
                      setSelectedRepoFullName('');
                      const derived = extractRepoNameFromUrl(nextUrl);
                      if (derived) {
                        if (!nameTouched) setName(derived);
                        if (!slugTouched) setSlug(toContainerSlug(derived));
                      }
                    }}
                    placeholder="https://github.com/username/my-app"
                    className="flex-1 bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3.5 py-2.5 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                  />
                  <button
                    type="button"
                    disabled={inspecting || !repoUrl.trim()}
                    onClick={handleInspectRepo}
                    className="px-4 py-2.5 bg-[#1F2937] hover:bg-slate-700 disabled:opacity-50 text-slate-100 font-medium rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${inspecting ? 'animate-spin' : ''}`} />
                    {inspecting ? 'در حال بررسی...' : 'بررسی مخزن'}
                  </button>
                </div>

                {selectedInstallationId > 0 && !githubToken.trim() ? (
                  <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2 text-emerald-300">
                    احراز هویت خصوصی، دسترسی GHCR و وب‌هوک خودکار توسط GitHub App مدیریت می‌شود (نیازی به PAT نیست).
                  </div>
                ) : (
                  <input
                    type="password"
                    value={githubToken}
                    onChange={(e) => setGithubToken(e.target.value)}
                    placeholder={
                      ghAppStatus?.installed
                        ? 'اختیاری: PAT دستی (در حالت عادی توسط GitHub App خودکار انجام می‌شود)'
                        : 'اختیاری: GitHub Personal Access Token (برای مخازن Private)'
                    }
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3.5 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                  />
                )}

                {inspectError && (
                  <div className="text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                    {inspectError}
                  </div>
                )}

                {inspectResult && (
                  <div className="bg-[#0B0F17] border border-emerald-500/30 rounded-lg p-3.5 space-y-1.5">
                    <div className="font-semibold text-emerald-400">
                      مخزن شناسایی شد: {inspectResult.owner}/{inspectResult.repo}
                    </div>
                    <div className="text-slate-300 flex flex-wrap gap-3 font-mono">
                      <span>نوع ساخت: {inspectResult.detectedBuildMode}</span>
                      <span>·</span>
                      <span>فایل: {inspectResult.detectedBuildFile}</span>
                      <span>·</span>
                      <span>پورت: {inspectResult.detectedPorts.join(', ')}</span>
                    </div>
                    {inspectResult.latestCommit && (
                      <div className="text-slate-400 truncate">
                        آخرین کامیت ({inspectResult.latestCommit.shortSha}):{' '}
                        {inspectResult.latestCommit.message}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Step 2: Project & Build Config */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-[#1F2937]">
                <div>
                  <label className="block text-slate-300 mb-1">نام نمایشی پروژه</label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setNameTouched(e.target.value.trim().length > 0);
                    }}
                    placeholder="test-sokkan1"
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">شناسه کانتینر (انگلیسی)</label>
                  <input
                    type="text"
                    required
                    value={slug}
                    onChange={(e) => {
                      setSlug(e.target.value);
                      setSlugTouched(e.target.value.trim().length > 0);
                    }}
                    placeholder="test-sokkan1"
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">شاخه گیت (Branch)</label>
                  <input
                    type="text"
                    required
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">روش بیلد داکر</label>
                  <select
                    value={buildMode}
                    onChange={(e) => {
                      const mode = e.target.value as 'dockerfile' | 'compose';
                      setBuildMode(mode);
                      setBuildFilePath(mode === 'compose' ? 'docker-compose.yml' : 'Dockerfile');
                    }}
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-sky-500"
                  >
                    <option value="dockerfile">Dockerfile تکی</option>
                    <option value="compose">Docker Compose</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">مسیر فایل بیلد</label>
                  <input
                    type="text"
                    value={buildFilePath}
                    onChange={(e) => setBuildFilePath(e.target.value)}
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">پورت داخلی سرویس (درون کانتینر)</label>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={containerPort}
                    onChange={(e) => setContainerPort(Number(e.target.value))}
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono tabular-nums focus:outline-none focus:border-sky-500"
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    هر کانتینر روی شبکه داخلی ایزوله است؛ مشترک بودن پورت 80 یا 3000 بین پروژه‌ها تداخلی ندارد.
                  </p>
                </div>
              </div>

              {/* Deploy Strategy Selector: Local VPS (BuildKit) vs GitHub Actions (GHCR) */}
              <div className="pt-2 border-t border-[#1F2937] space-y-3">
                <label className="block text-slate-300 font-medium">محل بیلد ایمیج (استراتژی دیپلوی)</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => setDeployStrategy('local')}
                    className={`text-right p-3 rounded-lg border transition-colors cursor-pointer ${
                      deployStrategy === 'local'
                        ? 'bg-sky-500/10 border-sky-500 text-slate-100'
                        : 'bg-[#0B0F17] border-[#1F2937] text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-semibold text-xs">بیلد روی سرور (VPS + BuildKit)</div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      ساخت مستقیم ایمیج روی همین سرور با buildx و کش لایه‌ها
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDeployStrategy('github_actions');
                      setPollingIntervalSec(0);
                    }}
                    className={`text-right p-3 rounded-lg border transition-colors cursor-pointer ${
                      deployStrategy === 'github_actions'
                        ? 'bg-violet-500/10 border-violet-500 text-slate-100'
                        : 'bg-[#0B0F17] border-[#1F2937] text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-semibold text-xs">بیلد با GitHub Actions (سریع)</div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      بیلد روی گیتهاب و دریافت مستقیم ایمیج آماده از GHCR بدون فشار به VPS
                    </div>
                  </button>
                </div>

                {deployStrategy === 'github_actions' && (
                  <div className="bg-[#0B0F17] border border-violet-500/25 rounded-lg p-3.5 space-y-2.5">
                    {buildMode === 'compose' ? (
                      <div>
                        <label className="block text-slate-300 mb-1">
                          فایل Docker Compose مخصوص ایمیج‌های آماده (GHCR)
                        </label>
                        <input
                          type="text"
                          value={actionsComposeFile}
                          onChange={(e) => setActionsComposeFile(e.target.value)}
                          placeholder="docker-compose.ghcr.yml"
                          className="w-full bg-[#111827] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-violet-500"
                        />
                        <p className="mt-1 text-[11px] text-slate-500">
                          سکان به‌جای بیلد، دستور <span className="font-mono">docker compose pull && up -d --no-build</span> را روی این فایل اجرا می‌کند.
                        </p>
                      </div>
                    ) : (
                      <div>
                        <label className="block text-slate-300 mb-1">آدرس ایمیج در GHCR (اختیاری)</label>
                        <input
                          type="text"
                          value={ghcrImage}
                          onChange={(e) => setGhcrImage(e.target.value)}
                          placeholder="ghcr.io/username/repo:latest"
                          className="w-full bg-[#111827] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-violet-500"
                        />
                        <p className="mt-1 text-[11px] text-slate-500">
                          اگر خالی بماند به‌صورت خودکار <span className="font-mono">ghcr.io/owner/repo:latest</span> در نظر گرفته می‌شود.
                        </p>
                      </div>
                    )}
                    <p className="text-[11px] text-slate-400">
                      نکته: برای ایمیج‌های خصوصی در GHCR، توکن گیتهاب پروژه باید مجوز <span className="font-mono text-slate-200">read:packages</span> داشته باشد. بعد از ساخت پروژه، فایل آماده Workflow در بخش تنظیمات پروژه قابل کپی است.
                    </p>
                  </div>
                )}
              </div>

              {/* Step 3: Caddy & Automation */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-[#1F2937]">
                <div>
                  <label className="block text-slate-300 mb-1">دامنه در Caddy (اختیاری)</label>
                  <input
                    type="text"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder="api.example.com"
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">بازه بررسی دوره‌ای (Polling)</label>
                  <select
                    value={pollingIntervalSec}
                    onChange={(e) => setPollingIntervalSec(Number(e.target.value))}
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-sky-500"
                  >
                    <option value={60}>هر ۱ دقیقه</option>
                    <option value={300}>هر ۵ دقیقه (پیشنهادی)</option>
                    <option value={900}>هر ۱۵ دقیقه</option>
                    <option value={0}>غیرفعال (فقط Webhook یا دستی)</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-slate-300 mb-1">شبکه خصوصی اجرایی (اختیاری)</label>
                  <select
                    value={privateNetworkId}
                    onChange={(e) => setPrivateNetworkId(e.target.value)}
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-sky-500"
                  >
                    <option value="">شبکه پیش‌فرض سرور (web)</option>
                    {networks.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.name} ({n.dockerName})
                      </option>
                    ))}
                  </select>
                </div>
                <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={caddyEnabled}
                    onChange={(e) => setCaddyEnabled(e.target.checked)}
                    className="accent-sky-500"
                  />
                  ساخت خودکار مسیر Reverse Proxy در Caddyfile
                </label>
                <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoDeployWebhook}
                    onChange={(e) => setAutoDeployWebhook(e.target.checked)}
                    className="accent-sky-500"
                  />
                  فعال‌سازی GitHub Webhook آنی
                </label>
              </div>

              {/* Step 4: Env Vars */}
              <div className="pt-2 border-t border-[#1F2937] space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-300 font-medium">متغیرهای محیطی (.env)</span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setShowBulkEnvAdd((v) => !v)}
                      className="text-slate-400 hover:text-slate-200 cursor-pointer"
                    >
                      {showBulkEnvAdd ? 'بستن ورود یکجا' : 'چسباندن یکجای .env'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEnvRows((prev) => [...prev, { key: '', value: '' }])}
                      className="text-sky-400 hover:text-sky-300 cursor-pointer"
                    >
                      + افزودن متغیر
                    </button>
                  </div>
                </div>
                {showBulkEnvAdd && (
                  <div className="space-y-2">
                    <textarea
                      rows={4}
                      value={bulkEnvAddText}
                      onChange={(e) => setBulkEnvAddText(e.target.value)}
                      placeholder={'DATABASE_URL=postgresql://...\nREDIS_URL=redis://...'}
                      dir="ltr"
                      className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg p-3 text-slate-100 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const parsed = parseBulkEnvText(bulkEnvAddText);
                        if (parsed.length > 0) {
                          setEnvRows((prev) => {
                            const map = new Map(prev.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));
                            for (const p of parsed) map.set(p.key, p.value);
                            return Array.from(map.entries()).map(([key, value]) => ({ key, value }));
                          });
                          setBulkEnvAddText('');
                          setShowBulkEnvAdd(false);
                        }
                      }}
                      className="px-3 py-1.5 bg-[#1F2937] hover:bg-slate-700 text-slate-100 rounded-lg cursor-pointer"
                    >
                      تبدیل به ردیف‌های .env
                    </button>
                  </div>
                )}
                {envRows.map((row, idx) => (
                  <div key={idx} className="flex gap-2">
                    <input
                      type="text"
                      value={row.key}
                      onChange={(e) =>
                        setEnvRows((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, key: e.target.value } : r)),
                        )
                      }
                      placeholder="KEY"
                      className="w-1/3 bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-1.5 text-slate-100 font-mono"
                    />
                    <input
                      type="text"
                      value={row.value}
                      onChange={(e) =>
                        setEnvRows((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r)),
                        )
                      }
                      placeholder="value"
                      className="flex-1 bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-1.5 text-slate-100 font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setEnvRows((prev) => prev.filter((_, i) => i !== idx))}
                      className="px-2 text-slate-400 hover:text-red-400 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>

              <div className="pt-4 border-t border-[#1F2937] flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-slate-300 hover:text-slate-100 cursor-pointer"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-5 py-2 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-semibold rounded-lg cursor-pointer"
                >
                  {creating ? 'در حال ثبت...' : 'ذخیره پروژه و ساخت Webhook'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Project Modal */}
      {editingProject && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="w-full max-w-xl bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-[#1F2937] flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-100">
                تنظیمات پروژه: {editingProject.name}
              </h2>
              <button
                type="button"
                onClick={() => setEditingProject(null)}
                className="text-slate-400 hover:text-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="p-6 overflow-y-auto space-y-4 text-xs">
              {editError && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3.5 py-2.5 text-red-400">
                  {editError}
                </div>
              )}
              <div className="bg-[#0B0F17] border border-[#1F2937] rounded-lg p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-200">آدرس Webhook گیتهاب</span>
                  <button
                    type="button"
                    onClick={handleRotateSecret}
                    className="text-sky-400 hover:text-sky-300 cursor-pointer"
                  >
                    تولید Secret جدید
                  </button>
                </div>
                <div className="font-mono text-[11px] text-slate-300 break-all">
                  {webhookOrigin}/api/webhooks/github/{editingProject.id}
                </div>
                {editRotatedSecret && (
                  <div className="text-emerald-400 font-mono text-[11px] break-all">
                    Secret جدید: {editRotatedSecret}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">شاخه هدف</label>
                  <input
                    type="text"
                    value={editBranch}
                    onChange={(e) => setEditBranch(e.target.value)}
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">بازه Polling</label>
                  <select
                    value={editPolling}
                    onChange={(e) => setEditPolling(Number(e.target.value))}
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100"
                  >
                    <option value={60}>هر ۱ دقیقه</option>
                    <option value={300}>هر ۵ دقیقه</option>
                    <option value={900}>هر ۱۵ دقیقه</option>
                    <option value={0}>غیرفعال</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">دامنه Caddy</label>
                  <input
                    type="text"
                    value={editDomain}
                    onChange={(e) => setEditDomain(e.target.value)}
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">پورت کانتینر</label>
                  <input
                    type="number"
                    value={editPort}
                    onChange={(e) => setEditPort(Number(e.target.value))}
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono tabular-nums"
                  />
                </div>
              </div>

              {/* Deploy Strategy Toggle */}
              <div className="space-y-2.5 pt-2 border-t border-[#1F2937]">
                <label className="block text-slate-300 font-medium">محل بیلد ایمیج (استراتژی دیپلوی)</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setEditDeployStrategy('local')}
                    className={`text-right p-2.5 rounded-lg border transition-colors cursor-pointer ${
                      editDeployStrategy === 'local'
                        ? 'bg-sky-500/10 border-sky-500 text-slate-100'
                        : 'bg-[#0B0F17] border-[#1F2937] text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-semibold text-xs">بیلد روی VPS (BuildKit)</div>
                    <div className="text-[10px] text-slate-400 mt-0.5">ساخت محلی روی سرور با buildx</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditDeployStrategy('github_actions')}
                    className={`text-right p-2.5 rounded-lg border transition-colors cursor-pointer ${
                      editDeployStrategy === 'github_actions'
                        ? 'bg-violet-500/10 border-violet-500 text-slate-100'
                        : 'bg-[#0B0F17] border-[#1F2937] text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-semibold text-xs">بیلد با GitHub Actions (GHCR)</div>
                    <div className="text-[10px] text-slate-400 mt-0.5">دریافت ایمیج آماده بدون فشار به VPS</div>
                  </button>
                </div>

                {editDeployStrategy === 'github_actions' && (
                  <div className="bg-[#0B0F17] border border-violet-500/25 rounded-lg p-3 space-y-3">
                    {editingProject.buildMode === 'compose' ? (
                      <div>
                        <label className="block text-slate-300 mb-1">
                          فایل Compose مخصوص ایمیج‌های آماده (GHCR)
                        </label>
                        <input
                          type="text"
                          value={editActionsComposeFile}
                          onChange={(e) => setEditActionsComposeFile(e.target.value)}
                          placeholder="docker-compose.ghcr.yml"
                          className="w-full bg-[#111827] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono"
                        />
                      </div>
                    ) : (
                      <div>
                        <label className="block text-slate-300 mb-1">آدرس ایمیج در GHCR</label>
                        <input
                          type="text"
                          value={editGhcrImage}
                          onChange={(e) => setEditGhcrImage(e.target.value)}
                          placeholder="ghcr.io/username/repo:latest"
                          className="w-full bg-[#111827] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono"
                        />
                      </div>
                    )}
                    <div>
                      <label className="block text-slate-300 mb-1">
                        به‌روزرسانی توکن گیتهاب (اختیاری — برای Pull خصوصی از GHCR دسترسی read:packages لازم است)
                      </label>
                      <input
                        type="password"
                        value={editGithubToken}
                        onChange={(e) => setEditGithubToken(e.target.value)}
                        placeholder={editingProject.hasGithubToken ? 'توکن فعلی ذخیره شده (برای تغییر وارد کنید)' : 'ghp_... یا github_pat_...'}
                        className="w-full bg-[#111827] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium text-violet-300">
                          نمونه فایل <span className="font-mono">.github/workflows/sokkan-deploy.yml</span>
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            copyText(
                              'gha-workflow',
                              buildSampleActionsWorkflow({
                                branch: editBranch,
                                buildMode: editingProject.buildMode,
                                buildFilePath: editingProject.buildFilePath,
                                ghcrImage: editGhcrImage,
                                repoUrl: editingProject.repoUrl,
                              }),
                            )
                          }
                          className="inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 cursor-pointer"
                        >
                          {copiedKey === 'gha-workflow' ? (
                            <>
                              <Check className="w-3 h-3" /> کپی شد
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" /> کپی YAML
                            </>
                          )}
                        </button>
                      </div>
                      <pre
                        dir="ltr"
                        className="bg-[#050810] border border-[#1F2937] rounded p-2.5 text-[10px] font-mono text-slate-300 overflow-x-auto max-h-40"
                      >
                        {buildSampleActionsWorkflow({
                          branch: editBranch,
                          buildMode: editingProject.buildMode,
                          buildFilePath: editingProject.buildFilePath,
                          ghcrImage: editGhcrImage,
                          repoUrl: editingProject.repoUrl,
                        })}
                      </pre>
                      <p className="text-[10px] text-slate-400">
                        در مخزن گیتهاب (Settings → Secrets → Actions) دو سکرت <span className="font-mono text-slate-200">SOKKAN_WEBHOOK_URL</span> و <span className="font-mono text-slate-200">SOKKAN_WEBHOOK_SECRET</span> را ست کنید تا پایان هر بیلد خودکار روی سکان دیپلوی شود.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-slate-300 mb-1">شبکه خصوصی اصلی پروژه</label>
                <select
                  value={editPrivateNetworkId}
                  onChange={(e) => setEditPrivateNetworkId(e.target.value)}
                  className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-sky-500"
                >
                  <option value="">شبکه پیش‌فرض سرور (web)</option>
                  {networks.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name} ({n.dockerName})
                    </option>
                  ))}
                </select>
              </div>

              {isAdmin && (
                <div>
                  <label className="block text-slate-300 mb-1">
                    دستورالعمل‌های اضافه داخل بلوک Caddy این پروژه (مخصوص مدیر کل)
                  </label>
                  <textarea
                    rows={3}
                    value={editExtraDirectives}
                    onChange={(e) => setEditExtraDirectives(e.target.value)}
                    placeholder="header Strict-Transport-Security max-age=31536000;"
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg p-3 text-slate-100 font-mono"
                  />
                </div>
              )}

              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editCaddyEnabled}
                    onChange={(e) => setEditCaddyEnabled(e.target.checked)}
                    className="accent-sky-500"
                  />
                  مسیر Caddy فعال
                </label>
                <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editWebhook}
                    onChange={(e) => setEditWebhook(e.target.checked)}
                    className="accent-sky-500"
                  />
                  دریافت Webhook فعال
                </label>
              </div>

              <div className="pt-2 border-t border-[#1F2937] space-y-2.5">
                <div className="text-slate-300 font-medium">
                  مدیریت متغیرهای محیطی (.env)
                </div>
                {editingProject.envKeys.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] font-mono">
                    {editingProject.envKeys.map((k) => {
                      const markedDelete = editDeletedEnvKeys.includes(k);
                      return (
                        <span
                          key={k}
                          className={`inline-flex items-center gap-1 ${
                            markedDelete ? 'line-through text-red-400' : 'text-slate-300'
                          }`}
                        >
                          <span>{k}</span>
                          <button
                            type="button"
                            title={markedDelete ? 'لغو حذف' : 'حذف متغیر'}
                            onClick={() =>
                              setEditDeletedEnvKeys((prev) =>
                                prev.includes(k) ? prev.filter((item) => item !== k) : [...prev, k],
                              )
                            }
                            className="text-slate-500 hover:text-red-400 cursor-pointer"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={editEnvKey}
                    onChange={(e) => setEditEnvKey(e.target.value)}
                    placeholder="VARIABLE_NAME"
                    className="w-1/3 bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono"
                  />
                  <input
                    type="text"
                    value={editEnvVal}
                    onChange={(e) => setEditEnvVal(e.target.value)}
                    placeholder="مقدار جدید"
                    className="flex-1 bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono"
                  />
                </div>
                <textarea
                  rows={2}
                  value={editBulkEnv}
                  onChange={(e) => setEditBulkEnv(e.target.value)}
                  placeholder="یا چند متغیر را یکجا وارد کنید: KEY=VALUE در هر خط"
                  dir="ltr"
                  className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg p-2.5 text-slate-100 font-mono text-[11px]"
                />
              </div>

              <div className="pt-3 border-t border-[#1F2937] flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setEditingProject(null)}
                  className="px-4 py-2 text-slate-300 cursor-pointer"
                >
                  بستن
                </button>
                <button
                  type="submit"
                  disabled={savingEdit}
                  className="px-5 py-2 bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold rounded-lg cursor-pointer"
                >
                  {savingEdit ? 'در حال ذخیره...' : 'ذخیره و همگام‌سازی Caddy'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
