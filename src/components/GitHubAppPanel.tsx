import {
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Globe,
  Link2,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Unlink,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../api';
import type { GitHubAppRepo, GitHubAppStatus } from '../types';

interface GitHubAppPanelProps {
  isAdmin: boolean;
  status: GitHubAppStatus | null;
  repos: GitHubAppRepo[];
  loadingRepos: boolean;
  onStatusChanged: () => void;
  onQuickAddProject: () => void;
}

export function GitHubAppPanel({
  isAdmin,
  status,
  repos,
  loadingRepos,
  onStatusChanged,
  onQuickAddProject,
}: GitHubAppPanelProps) {
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [customAppName, setCustomAppName] = useState('');
  const [organization, setOrganization] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin &&
        !event.origin.endsWith('.run.app')
      ) {
        return;
      }
      if (!event.data || typeof event.data !== 'object') return;
      const payload = event.data as { type?: string; stage?: string };
      if (payload.type === 'SOKKAN_GITHUB_APP_EVENT') {
        if (payload.stage === 'created') {
          setNotice('اپلیکیشن گیتهاب ساخته شد. در پنجره بازشده مخازن مجاز را انتخاب و نصب کنید.');
        } else if (payload.stage === 'installed') {
          setNotice('اتصال یک‌کلیکی گیتهاب کامل شد و لیست مخازن آماده است.');
        }
        setError('');
        onStatusChanged();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onStatusChanged]);

  const handleOneClickConnect = async () => {
    setConnecting(true);
    setError('');
    setNotice('');

    // Open blank popup synchronously inside click gesture to avoid popup blockers
    const popupName = 'sokkan_github_app_flow';
    const popup = window.open('about:blank', popupName, 'width=820,height=780');

    try {
      const res = await apiFetch<{
        actionUrl: string;
        manifestJson: string;
        isHttps: boolean;
      }>('/api/github/app/manifest', {
        method: 'POST',
        body: JSON.stringify({
          baseUrl: window.location.origin,
          appName: customAppName.trim() || undefined,
          organization: organization.trim() || undefined,
        }),
      });

      const form = document.createElement('form');
      form.method = 'POST';
      form.action = res.actionUrl;
      form.target = popup ? popupName : '_blank';
      form.style.display = 'none';

      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'manifest';
      input.value = res.manifestJson;
      form.appendChild(input);

      document.body.appendChild(form);
      form.submit();
      document.body.removeChild(form);

      setNotice(
        'صفحه تایید ساخت اپلیکیشن در گیتهاب باز شد. پس از کلیک روی Create و انتخاب مخازن، این صفحه خودکار بروز می‌شود.',
      );
    } catch (err) {
      if (popup && !popup.closed) {
        popup.close();
      }
      setError(err instanceof Error ? err.message : 'خطا در شروع اتصال به گیتهاب');
    } finally {
      setConnecting(false);
    }
  };

  const handleOpenInstallPage = () => {
    if (!status?.installUrl) return;
    window.open(status.installUrl, 'sokkan_github_app_install', 'width=820,height=780');
  };

  const handleSync = async () => {
    setSyncing(true);
    setError('');
    setNotice('');
    try {
      await apiFetch('/api/github/app/sync', { method: 'POST' });
      setNotice('وضعیت نصب و لیست مخازن گیتهاب با موفقیت همگام‌سازی شد.');
      onStatusChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در همگام‌سازی گیتهاب');
    } finally {
      setSyncing(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    setError('');
    setNotice('');
    try {
      await apiFetch('/api/github/app', { method: 'DELETE' });
      setConfirmDisconnect(false);
      setNotice('اتصال GitHub App از سکان حذف شد.');
      onStatusChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در قطع اتصال گیتهاب');
    } finally {
      setDisconnecting(false);
    }
  };

  if (!status) {
    return null;
  }

  return (
    <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5 space-y-3.5">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <Link2 className="w-4 h-4 text-sky-400 shrink-0" />
            <h2 className="text-sm font-semibold text-slate-100">
              اتصال یک‌کلیکی به گیتهاب (GitHub App)
            </h2>
            {status.connected && status.installed && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-md">
                <CheckCircle2 className="w-3 h-3" />
                متصل و فعال
              </span>
            )}
            {status.connected && !status.installed && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-md">
                در انتظار انتخاب مخازن
              </span>
            )}
          </div>

          {!status.connected ? (
            <p className="text-xs text-slate-400 leading-relaxed">
              بدون نیاز به ساخت دستی PAT یا تنظیم جداگانه Webhook برای هر مخزن — با دو کلیک اپلیکیشن اختصاصی گیتهاب شما ساخته می‌شود، لیست مخازن می‌آید و کلون خصوصی، GHCR و وبهوک‌ها خودکار کار می‌کنند.
            </p>
          ) : status.installed ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
              <span>
                اپلیکیشن:{' '}
                <a
                  href={status.htmlUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  dir="ltr"
                  className="font-mono text-slate-200 hover:text-sky-400 inline-flex items-center gap-1"
                >
                  {status.name}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </span>
              <span>·</span>
              <span>
                حساب متصل:{' '}
                <span dir="ltr" className="font-mono text-sky-400">
                  {status.installations.map((i) => `@${i.accountLogin}`).join(', ')}
                </span>
              </span>
              <span>·</span>
              <span className="tabular-nums text-slate-300">
                {loadingRepos ? 'در حال دریافت مخازن...' : `${repos.length} مخزن قابل انتخاب`}
              </span>
            </div>
          ) : (
            <p className="text-xs text-amber-300/90 leading-relaxed">
              اپلیکیشن <span dir="ltr" className="font-mono">{status.name}</span> ساخته شد. روی «انتخاب مخازن در گیتهاب» کلیک کنید تا به مخازن مورد نظرتان دسترسی بدهید.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {!status.connected && isAdmin && (
            <>
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="px-3 py-2 text-xs text-slate-300 hover:text-slate-100 bg-[#0B0F17] border border-[#1F2937] hover:border-slate-600 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <Settings2 className="w-3.5 h-3.5" />
                تنظیمات نام / سازمان
              </button>
              <button
                type="button"
                onClick={handleOneClickConnect}
                disabled={connecting}
                className="px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-500 hover:bg-sky-400 disabled:opacity-60 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <Link2 className="w-3.5 h-3.5" />
                {connecting ? 'در حال اتصال...' : 'اتصال یک‌کلیکی به گیتهاب'}
              </button>
            </>
          )}

          {!status.connected && !isAdmin && (
            <span className="text-xs text-slate-400 bg-[#0B0F17] border border-[#1F2937] px-3 py-2 rounded-lg">
              اتصال GitHub App توسط مدیر کل انجام می‌شود
            </span>
          )}

          {status.connected && !status.installed && (
            <>
              <button
                type="button"
                onClick={handleOpenInstallPage}
                className="px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                انتخاب مخازن در گیتهاب
              </button>
              {isAdmin && (
                <button
                  type="button"
                  onClick={handleSync}
                  disabled={syncing}
                  className="px-3 py-2 text-xs text-slate-200 bg-[#0B0F17] border border-[#1F2937] hover:border-slate-600 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                  همگام‌سازی
                </button>
              )}
            </>
          )}

          {status.connected && status.installed && (
            <>
              <button
                type="button"
                onClick={onQuickAddProject}
                className="px-3.5 py-2 text-xs font-semibold text-slate-950 bg-sky-500 hover:bg-sky-400 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                انتخاب از مخازن گیتهاب
              </button>
              {isAdmin && (
                <>
                  <button
                    type="button"
                    onClick={handleOpenInstallPage}
                    className="px-3 py-2 text-xs text-slate-200 bg-[#0B0F17] border border-[#1F2937] hover:border-slate-600 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    تغییر مخازن مجاز
                  </button>
                  <button
                    type="button"
                    onClick={handleSync}
                    disabled={syncing}
                    title="همگام‌سازی لیست مخازن"
                    className="p-2 text-slate-300 hover:text-slate-100 bg-[#0B0F17] border border-[#1F2937] hover:border-slate-600 rounded-lg transition-colors cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                  </button>
                </>
              )}
            </>
          )}

          {status.connected && isAdmin && (
            confirmDisconnect ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  className="px-3 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-500 rounded-lg cursor-pointer whitespace-nowrap"
                >
                  {disconnecting ? 'در حال حذف...' : 'تایید قطع اتصال'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDisconnect(false)}
                  className="px-2.5 py-2 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  انصراف
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDisconnect(true)}
                title="قطع اتصال GitHub App"
                className="p-2 text-slate-400 hover:text-red-400 bg-[#0B0F17] border border-[#1F2937] hover:border-red-500/40 rounded-lg transition-colors cursor-pointer"
              >
                <Unlink className="w-3.5 h-3.5" />
              </button>
            )
          )}
        </div>
      </div>

      {!status.connected && isAdmin && showAdvanced && (
        <div className="bg-[#0B0F17] border border-[#1F2937] rounded-lg p-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div>
            <label className="block text-slate-300 mb-1">
              نام اپلیکیشن در گیتهاب (اختیاری — باید در کل گیتهاب یکتا باشد)
            </label>
            <input
              type="text"
              value={customAppName}
              onChange={(e) => setCustomAppName(e.target.value)}
              placeholder="مثال: sokkan-myserver (خالی = خودکار)"
              dir="ltr"
              className="w-full bg-[#111827] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
            />
          </div>
          <div>
            <label className="block text-slate-300 mb-1">
              سازمان گیتهاب / Organization (اختیاری — خالی = حساب شخصی)
            </label>
            <input
              type="text"
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
              placeholder="مثال: my-company-org"
              dir="ltr"
              className="w-full bg-[#111827] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
            />
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3.5 py-2.5 text-xs text-red-300 flex items-center justify-between gap-2">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError('')}
            className="text-red-400 hover:text-red-200 cursor-pointer shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {notice && (
        <div className="bg-sky-500/10 border border-sky-500/20 rounded-lg px-3.5 py-2.5 text-xs text-sky-300">
          {notice}
        </div>
      )}
    </div>
  );
}

interface GitHubRepoPickerProps {
  repos: GitHubAppRepo[];
  loading: boolean;
  selectedFullName: string;
  onSelect: (repo: GitHubAppRepo) => void;
  onRefresh: () => void;
}

export function GitHubRepoPicker({
  repos,
  loading,
  selectedFullName,
  onSelect,
  onRefresh,
}: GitHubRepoPickerProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return repos.slice(0, 40);
    return repos
      .filter(
        (r) =>
          r.fullName.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q),
      )
      .slice(0, 40);
  }, [repos, query]);

  return (
    <div className="bg-[#0B0F17] border border-sky-500/30 rounded-lg p-3.5 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-sky-300 flex items-center gap-1.5">
          <Link2 className="w-3.5 h-3.5" />
          انتخاب سریع از مخازن گیتهاب متصل‌شده ({repos.length})
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="text-[11px] text-slate-400 hover:text-sky-300 flex items-center gap-1 cursor-pointer"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          بروزرسانی لیست
        </button>
      </div>

      <div className="relative">
        <Search className="w-3.5 h-3.5 text-slate-500 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="جستجوی نام مخزن..."
          className="w-full bg-[#111827] border border-[#1F2937] rounded-lg pr-8 pl-3 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-sky-500"
        />
      </div>

      {loading ? (
        <div className="py-4 text-center text-xs text-slate-400">
          در حال دریافت لیست مخازن از گیتهاب...
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-4 text-center text-xs text-slate-400">
          {repos.length === 0
            ? 'هیچ مخزنی برای این GitHub App مجاز نشده است.'
            : 'مخزنی با این عبارت پیدا نشد.'}
        </div>
      ) : (
        <div className="max-h-44 overflow-y-auto divide-y divide-[#1F2937] border border-[#1F2937] rounded-lg bg-[#111827]">
          {filtered.map((repo) => {
            const isSelected = selectedFullName.toLowerCase() === repo.fullName.toLowerCase();
            return (
              <button
                key={repo.id}
                type="button"
                onClick={() => onSelect(repo)}
                className={`w-full px-3 py-2 text-right flex items-center justify-between gap-3 transition-colors cursor-pointer ${
                  isSelected
                    ? 'bg-sky-500/15 text-sky-200'
                    : 'hover:bg-slate-800/60 text-slate-200'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {repo.isPrivate ? (
                      <Lock className="w-3 h-3 text-amber-400 shrink-0" />
                    ) : (
                      <Globe className="w-3 h-3 text-slate-400 shrink-0" />
                    )}
                    <span dir="ltr" className="font-mono text-xs font-medium truncate">
                      {repo.fullName}
                    </span>
                  </div>
                  {repo.description && (
                    <div className="text-[11px] text-slate-400 truncate mt-0.5">
                      {repo.description}
                    </div>
                  )}
                </div>
                <span
                  dir="ltr"
                  className="text-[10px] font-mono text-slate-400 bg-[#0B0F17] border border-[#1F2937] px-1.5 py-0.5 rounded flex items-center gap-1 shrink-0"
                >
                  <GitBranch className="w-2.5 h-2.5" />
                  {repo.defaultBranch}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
