import { Box, HardDrive, Play, RefreshCw, RotateCcw, Search, Square, Terminal, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import type { DockerContainer, DockerDiskCategory, NavTab } from '../types';

interface ContainersPageProps {
  onNavigate: (tab: NavTab) => void;
}

export function ContainersPage({ onNavigate }: ContainersPageProps) {
  const [dockerAvailable, setDockerAvailable] = useState(true);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'running' | 'stopped'>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const [selectedLogs, setSelectedLogs] = useState<{
    name: string;
    id: string;
    logs: string;
    loading: boolean;
  } | null>(null);

  const [statsMap, setStatsMap] = useState<
    Record<string, { cpuPercent: number; memUsedMb: number; memLimitMb: number; memPercent: number }>
  >({});
  const [diskCategories, setDiskCategories] = useState<DockerDiskCategory[]>([]);
  const [pruning, setPruning] = useState(false);
  const [confirmPrune, setConfirmPrune] = useState(false);
  const [pruneNotice, setPruneNotice] = useState('');

  const loadContainers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [res, df] = await Promise.all([
        apiFetch<{ dockerAvailable: boolean; containers: DockerContainer[] }>('/api/containers'),
        apiFetch<{ dockerAvailable: boolean; categories: DockerDiskCategory[] }>(
          '/api/docker/disk-usage',
        ).catch(() => ({ dockerAvailable: false, categories: [] })),
      ]);
      setDockerAvailable(res.dockerAvailable);
      setContainers(res.containers);
      setDiskCategories(df.categories);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در خواندن کانتینرهای داکر');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadContainers();
  }, [loadContainers]);

  const handlePruneDocker = async () => {
    setPruning(true);
    setError('');
    setPruneNotice('');
    try {
      const res = await apiFetch<{ reclaimedSummary: string; categories: DockerDiskCategory[] }>(
        '/api/docker/prune',
        { method: 'POST' },
      );
      setDiskCategories(res.categories);
      setPruneNotice(res.reclaimedSummary);
      setConfirmPrune(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'پاک‌سازی کش داکر ناموفق بود');
    } finally {
      setPruning(false);
    }
  };

  const handleAction = async (id: string, action: 'start' | 'stop' | 'restart' | 'remove') => {
    setBusyId(id);
    setError('');
    try {
      await apiFetch(`/api/containers/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      setConfirmRemoveId(null);
      await loadContainers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'اجرای عملیات روی کانتینر ناموفق بود');
    } finally {
      setBusyId(null);
    }
  };

  const handleFetchLogs = async (container: DockerContainer) => {
    setSelectedLogs({ name: container.name, id: container.id, logs: '', loading: true });
    try {
      const res = await apiFetch<{ logs: string }>(
        `/api/containers/${encodeURIComponent(container.id)}/logs?tail=250`,
      );
      setSelectedLogs({ name: container.name, id: container.id, logs: res.logs, loading: false });
    } catch (err) {
      setSelectedLogs({
        name: container.name,
        id: container.id,
        logs: err instanceof Error ? err.message : 'خطا در خواندن لاگ',
        loading: false,
      });
    }
  };

  const handleFetchStats = async (id: string) => {
    try {
      const s = await apiFetch<{
        cpuPercent: number;
        memUsedMb: number;
        memLimitMb: number;
        memPercent: number;
      }>(`/api/containers/${encodeURIComponent(id)}/stats`);
      setStatsMap((prev) => ({ ...prev, [id]: s }));
    } catch {
      // Ignore transient stats error
    }
  };

  const filtered = containers.filter((c) => {
    const matchesSearch =
      !search.trim() ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.image.toLowerCase().includes(search.toLowerCase());
    const isRunning = c.state === 'running';
    const matchesState =
      filter === 'all' || (filter === 'running' && isRunning) || (filter === 'stopped' && !isRunning);
    return matchesSearch && matchesState;
  });

  return (
    <div className="space-y-6">
      {!dockerAvailable && !loading && (
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-6 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-400">
            <Box className="w-4 h-4" />
            <span>سوکت Docker در این محیط متصل نیست</span>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed max-w-3xl">
            در محیط پیش‌نمایش ابری دسترسی به <code className="text-sky-400">/var/run/docker.sock</code> وجود ندارد.
            به محض اجرای همین پنل روی VPS با فایل Compose تولیدشده، تمام کانتینرهای سرور (سرویس‌های دیپلوی‌شده، Caddy و ...)
            در این بخش بدون نیاز به Portainer قابل کنترل، ری‌استارت و مشاهده لاگ خواهند بود.
          </p>
          <button
            type="button"
            onClick={() => onNavigate('provisioning')}
            className="px-4 py-2 text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 rounded-lg cursor-pointer"
          >
            مشاهده فایل‌های نصب روی VPS
          </button>
        </div>
      )}

      {dockerAvailable && (
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
              <HardDrive className="w-4 h-4 text-sky-400" />
              <span>مصرف فضای دیسک داکر و پاک‌سازی کش بیلد</span>
            </div>
            {diskCategories.length > 0 ? (
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400 font-mono tabular-nums">
                {diskCategories.map((cat, idx) => (
                  <span key={cat.type} className="inline-flex items-center gap-1.5">
                    {idx > 0 && <span className="text-slate-600">·</span>}
                    <span className="text-slate-300">{cat.type}:</span>
                    <span>{cat.size}</span>
                    {cat.reclaimable && cat.reclaimable !== '0B' && (
                      <span className="text-amber-400">({cat.reclaimable} قابل آزادسازی)</span>
                    )}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-400">
                پاک‌سازی ایمن ایمیج‌های بلااستفاده و کش بیلد (کانتینرهای فعال و Volumeها دست‌نخورده می‌مانند).
              </p>
            )}
            {pruneNotice && <p className="text-xs text-emerald-400 font-mono">{pruneNotice}</p>}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {confirmPrune ? (
              <>
                <button
                  type="button"
                  disabled={pruning}
                  onClick={handlePruneDocker}
                  className="px-3.5 py-2 text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-lg cursor-pointer whitespace-nowrap"
                >
                  {pruning ? 'در حال پاک‌سازی...' : 'تایید پاک‌سازی ایمن'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmPrune(false)}
                  className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  انصراف
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmPrune(true)}
                className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#0B0F17] border border-[#1F2937] hover:border-amber-500/40 rounded-lg cursor-pointer whitespace-nowrap"
              >
                پاک‌سازی کش و ایمیج‌های قدیمی
              </button>
            )}
          </div>
        </div>
      )}

      <div className="bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden">
        <div className="p-4 border-b border-[#1F2937] flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1">
            <div className="relative flex-1 max-w-xs">
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="جستجو نام کانتینر یا ایمیج..."
                className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg pr-9 pl-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-500"
              />
            </div>

            <div className="flex items-center gap-1 p-1 bg-[#0B0F17] border border-[#1F2937] rounded-lg">
              {(['all', 'running', 'stopped'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setFilter(tab)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                    filter === tab
                      ? 'bg-[#1F2937] text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab === 'all' ? 'همه' : tab === 'running' ? 'در حال اجرا' : 'متوقف'}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={loadContainers}
            className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#0B0F17] border border-[#1F2937] hover:border-slate-600 rounded-lg flex items-center gap-2 cursor-pointer whitespace-nowrap self-start"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            بروزرسانی لیست
          </button>
        </div>

        {error && (
          <div className="m-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
            {error}
          </div>
        )}

        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-12 bg-[#0B0F17] rounded-lg animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-400">
            {dockerAvailable
              ? 'کانتینری با فیلتر فعلی پیدا نشد.'
              : 'لیست کانتینرها پس از نصب روی سرور VPS در این جدول نمایش داده می‌شود.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-right">
              <thead className="bg-[#0B0F17] text-slate-400 border-b border-[#1F2937]">
                <tr>
                  <th className="py-3 px-4 font-medium">نام کانتینر</th>
                  <th className="py-3 px-4 font-medium">ایمیج</th>
                  <th className="py-3 px-4 font-medium">پورت‌ها و شبکه</th>
                  <th className="py-3 px-4 font-medium">وضعیت</th>
                  <th className="py-3 px-4 font-medium">منابع</th>
                  <th className="py-3 px-4 font-medium text-left">عملیات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1F2937]">
                {filtered.map((c) => {
                  const isRunning = c.state === 'running';
                  const st = statsMap[c.id];
                  return (
                    <tr key={c.id} className="hover:bg-slate-800/30 transition-colors">
                      <td className="py-3 px-4">
                        <div className="font-mono font-medium text-slate-100">{c.name}</div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          <span className="font-mono">{c.shortId}</span>
                          {c.managedByPanel && ' · مدیریت‌شده توسط سکان'}
                        </div>
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-300 max-w-[200px] truncate">
                        {c.image}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-400 tabular-nums">
                        {c.ports.length > 0 ? c.ports.slice(0, 2).join(' · ') : 'داخلی'}
                        {c.networks.length > 0 && (
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            {c.networks.join(', ')}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`font-medium ${
                            isRunning ? 'text-emerald-400' : 'text-slate-400'
                          }`}
                        >
                          {isRunning ? 'فعال' : 'متوقف'}
                        </span>
                        <div className="text-[11px] text-slate-500 mt-0.5">{c.status}</div>
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-300">
                        {st ? (
                          <div>
                            <div>CPU {st.cpuPercent}%</div>
                            <div className="text-[11px] text-slate-400">
                              {st.memUsedMb} MB ({st.memPercent}%)
                            </div>
                          </div>
                        ) : isRunning ? (
                          <button
                            type="button"
                            onClick={() => handleFetchStats(c.id)}
                            className="text-sky-400 hover:text-sky-300 cursor-pointer"
                          >
                            اندازه‌گیری
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleFetchLogs(c)}
                            title="مشاهده لاگ"
                            className="p-2 rounded-lg bg-[#0B0F17] border border-[#1F2937] hover:border-sky-500/50 text-slate-300 cursor-pointer"
                          >
                            <Terminal className="w-3.5 h-3.5" />
                          </button>
                          {isRunning ? (
                            <button
                              type="button"
                              disabled={busyId === c.id}
                              onClick={() => handleAction(c.id, 'stop')}
                              title="توقف"
                              className="p-2 rounded-lg bg-[#0B0F17] border border-[#1F2937] hover:border-amber-500/50 text-amber-400 cursor-pointer"
                            >
                              <Square className="w-3.5 h-3.5" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={busyId === c.id}
                              onClick={() => handleAction(c.id, 'start')}
                              title="شروع"
                              className="p-2 rounded-lg bg-[#0B0F17] border border-[#1F2937] hover:border-emerald-500/50 text-emerald-400 cursor-pointer"
                            >
                              <Play className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busyId === c.id}
                            onClick={() => handleAction(c.id, 'restart')}
                            title="ری‌استارت"
                            className="p-2 rounded-lg bg-[#0B0F17] border border-[#1F2937] hover:border-sky-500/50 text-sky-400 cursor-pointer"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>

                          {confirmRemoveId === c.id ? (
                            <button
                              type="button"
                              disabled={busyId === c.id}
                              onClick={() => handleAction(c.id, 'remove')}
                              className="px-2.5 py-1.5 rounded-lg bg-red-500 text-white text-[11px] font-medium cursor-pointer whitespace-nowrap"
                            >
                              تایید حذف
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmRemoveId(c.id)}
                              title="حذف کانتینر"
                              className="p-2 rounded-lg bg-[#0B0F17] border border-[#1F2937] hover:border-red-500/50 text-red-400 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Container Logs Modal */}
      {selectedLogs && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-4xl bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden flex flex-col max-h-[85vh]">
            <div className="px-5 py-3.5 border-b border-[#1F2937] flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <Terminal className="w-4 h-4 text-sky-400" />
                <span>لاگ زنده کانتینر</span>
                <span className="font-mono text-xs text-slate-400">{selectedLogs.name}</span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedLogs(null)}
                className="p-1.5 text-slate-400 hover:text-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <pre className="p-5 bg-[#0B0F17] text-xs font-mono text-slate-300 overflow-auto flex-1 whitespace-pre-wrap leading-relaxed">
              {selectedLogs.loading
                ? 'در حال دریافت لاگ از داکر...'
                : selectedLogs.logs || 'خروجی لاگی ثبت نشده است.'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
