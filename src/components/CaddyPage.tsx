import { CheckCircle2, FileCode2, Globe, History, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import type { CaddyState } from '../types';

export function CaddyPage() {
  const [caddyState, setCaddyState] = useState<CaddyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'editor' | 'routes'>('editor');

  const [editorContent, setEditorContent] = useState('');
  const [commitNote, setCommitNote] = useState('');
  const [validationStatus, setValidationStatus] = useState<{
    checked: boolean;
    valid: boolean;
    errors: string[];
    validatedBy?: string;
  } | null>(null);

  const [applying, setApplying] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'warn' | 'err'; text: string } | null>(null);

  const loadCaddy = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<CaddyState>('/api/caddy');
      setCaddyState(data);
      setEditorContent(data.content);
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'خطا در دریافت تنظیمات Caddy',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCaddy();
  }, [loadCaddy]);

  const handleValidate = async () => {
    setFeedback(null);
    try {
      const res = await apiFetch<{
        valid: boolean;
        errors: string[];
        validatedBy: string;
      }>('/api/caddy/validate', {
        method: 'POST',
        body: JSON.stringify({ content: editorContent }),
      });
      setValidationStatus({ checked: true, ...res });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'خطا در اعتبارسنجی',
      });
    }
  };

  const handleApply = async () => {
    setApplying(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ message: string; appliedToLiveCaddy: boolean }>(
        '/api/caddy/apply',
        {
          method: 'POST',
          body: JSON.stringify({
            content: editorContent,
            note: commitNote.trim() || 'ویرایش دستی Caddyfile',
          }),
        },
      );
      setCommitNote('');
      setValidationStatus(null);
      setFeedback({ type: res.appliedToLiveCaddy ? 'ok' : 'warn', text: res.message });
      await loadCaddy();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'خطا در اعمال تنظیمات Caddyfile',
      });
    } finally {
      setApplying(false);
    }
  };

  const handleSyncRoutes = async () => {
    setApplying(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ content: string }>('/api/caddy/sync-routes', {
        method: 'POST',
      });
      setEditorContent(res.content);
      setFeedback({ type: 'ok', text: 'مسیرهای پروژه‌ها با Caddyfile همگام‌سازی شد.' });
      await loadCaddy();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'خطا در همگام‌سازی مسیرها',
      });
    } finally {
      setApplying(false);
    }
  };

  const handleToggleRoute = async (projectId: string, nextEnabled: boolean) => {
    setFeedback(null);
    try {
      await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ caddyEnabled: nextEnabled }),
      });
      await loadCaddy();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'خطا در تغییر وضعیت مسیر',
      });
    }
  };

  const handleRollback = async (snapshotId: string) => {
    setApplying(true);
    setFeedback(null);
    try {
      const res = await apiFetch<{ message: string }>(
        `/api/caddy/rollback/${encodeURIComponent(snapshotId)}`,
        { method: 'POST' },
      );
      setFeedback({ type: 'ok', text: res.message });
      await loadCaddy();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'خطا در بازگشت به نسخه قبلی',
      });
    } finally {
      setApplying(false);
    }
  };

  if (loading && !caddyState) {
    return <div className="h-96 bg-[#111827] border border-[#1F2937] rounded-xl animate-pulse" />;
  }

  return (
    <div className="space-y-6">
      {/* Status & Mode Header */}
      <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Globe className="w-4 h-4 text-sky-400" />
            <span>مدیریت Caddy Reverse Proxy و گواهی SSL خودکار</span>
          </div>
          <p className="text-xs text-slate-400">
            وضعیت اتصال Caddy:{' '}
            <span
              className={
                caddyState?.caddyStatus.reachable ? 'text-emerald-400 font-medium' : 'text-amber-400 font-medium'
              }
            >
              {caddyState?.caddyStatus.reachable
                ? `متصل (${
                    caddyState.caddyStatus.mode === 'admin_api'
                      ? 'Admin API :2019'
                      : caddyState.caddyStatus.mode === 'docker_exec'
                        ? 'Docker Exec (caddy)'
                        : 'Caddy CLI'
                  })`
                : 'آماده اعمال (روی VPS دارای Caddy به صورت زنده Reload می‌شود)'}
            </span>
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 p-1 bg-[#0B0F17] border border-[#1F2937] rounded-lg">
            <button
              type="button"
              onClick={() => setActiveTab('editor')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                activeTab === 'editor' ? 'bg-[#1F2937] text-slate-100' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              ویرایشگر Caddyfile کلی
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('routes')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                activeTab === 'routes' ? 'bg-[#1F2937] text-slate-100' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              مسیرهای پروژه‌ها ({caddyState?.routes.length ?? 0})
            </button>
          </div>
        </div>
      </div>

      {feedback && (
        <div
          className={`rounded-xl px-4 py-3 text-xs border ${
            feedback.type === 'ok'
              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
              : feedback.type === 'warn'
                ? 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                : 'bg-red-500/10 border-red-500/20 text-red-400'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {activeTab === 'editor' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Global Caddyfile Editor */}
          <div className="lg:col-span-2 bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden flex flex-col">
            <div className="px-5 py-3.5 border-b border-[#1F2937] flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <FileCode2 className="w-4 h-4 text-sky-400" />
                <span>Caddyfile سراسری سرور</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSyncRoutes}
                  disabled={applying}
                  className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#0B0F17] border border-[#1F2937] hover:border-slate-600 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  تزریق مسیر پروژه‌ها
                </button>
                <button
                  type="button"
                  onClick={handleValidate}
                  className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#0B0F17] border border-[#1F2937] hover:border-sky-500/40 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-sky-400" />
                  اعتبارسنجی سینتکس
                </button>
              </div>
            </div>

            <textarea
              value={editorContent}
              onChange={(e) => {
                setEditorContent(e.target.value);
                setValidationStatus(null);
              }}
              spellCheck={false}
              rows={18}
              className="w-full bg-[#0B0F17] p-5 text-xs font-mono text-slate-200 focus:outline-none leading-relaxed resize-y"
            />

            {validationStatus?.checked && (
              <div
                className={`px-5 py-2.5 text-xs border-t border-[#1F2937] ${
                  validationStatus.valid ? 'text-emerald-400 bg-emerald-500/5' : 'text-red-400 bg-red-500/5'
                }`}
              >
                {validationStatus.valid ? (
                  <span className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    سینتکس Caddyfile معتبر است (بررسی توسط {validationStatus.validatedBy}).
                  </span>
                ) : (
                  <div>{validationStatus.errors.join(' | ')}</div>
                )}
              </div>
            )}

            <div className="p-4 border-t border-[#1F2937] flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
              <input
                type="text"
                value={commitNote}
                onChange={(e) => setCommitNote(e.target.value)}
                placeholder="توضیح کوتاه تغییر (برای ثبت در تاریخچه بازگشت)..."
                className="flex-1 bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3.5 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-500"
              />
              <button
                type="button"
                disabled={applying}
                onClick={handleApply}
                className="px-5 py-2 text-xs font-semibold bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 rounded-lg cursor-pointer whitespace-nowrap"
              >
                {applying ? 'در حال اعمال...' : 'اعتبارسنجی و Reload Caddy'}
              </button>
            </div>
          </div>

          {/* Snapshots / Rollback */}
          <div className="bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden flex flex-col">
            <div className="px-5 py-3.5 border-b border-[#1F2937] flex items-center gap-2 text-xs font-semibold text-slate-200">
              <History className="w-4 h-4 text-sky-400" />
              <span>تاریخچه نسخه‌ها و بازگشت سریع</span>
            </div>
            <div className="divide-y divide-[#1F2937] overflow-y-auto max-h-[500px]">
              {(caddyState?.snapshots ?? []).map((snap, idx) => (
                <div key={snap.id} className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-xs font-medium text-slate-200">{snap.note}</div>
                    {idx === 0 && (
                      <span className="text-[11px] text-emerald-400 shrink-0">نسخه فعلی</span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono tabular-nums">
                    {new Date(snap.created_at).toLocaleString('fa-IR')}
                  </div>
                  {idx > 0 && (
                    <button
                      type="button"
                      disabled={applying}
                      onClick={() => handleRollback(snap.id)}
                      className="text-xs text-sky-400 hover:text-sky-300 inline-flex items-center gap-1 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" />
                      بازگشت به این نسخه
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-[#1F2937] flex items-center justify-between">
            <div className="text-xs text-slate-300">
              مسیرهایی که در این جدول فعال هستند به صورت خودکار داخل بخش{' '}
              <code className="text-sky-400"># BEGIN MANAGED ROUTES</code> در Caddyfile تزریق می‌شوند.
            </div>
            <button
              type="button"
              onClick={handleSyncRoutes}
              disabled={applying}
              className="px-3.5 py-2 text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 rounded-lg cursor-pointer whitespace-nowrap"
            >
              همگام‌سازی و Reload
            </button>
          </div>

          {!caddyState || caddyState.routes.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-400">
              هنوز هیچ پروژه‌ای ثبت نشده است. پس از افزودن پروژه، دامنه و پورت آن اینجا مدیریت می‌شود.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-right">
                <thead className="bg-[#0B0F17] text-slate-400 border-b border-[#1F2937]">
                  <tr>
                    <th className="py-3 px-4 font-medium">پروژه</th>
                    <th className="py-3 px-4 font-medium">دامنه عمومی</th>
                    <th className="py-3 px-4 font-medium">مقصد داخلی (Upstream)</th>
                    <th className="py-3 px-4 font-medium">وضعیت مسیر</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1F2937]">
                  {caddyState.routes.map((r) => (
                    <tr key={r.projectId} className="hover:bg-slate-800/30">
                      <td className="py-3 px-4 font-medium text-slate-100">{r.name}</td>
                      <td className="py-3 px-4 font-mono text-sky-400">
                        {r.domain || <span className="text-slate-500">تعریف نشده</span>}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-300 tabular-nums">
                        {r.upstream}
                      </td>
                      <td className="py-3 px-4">
                        {r.sourceType === 'service' ? (
                          <span className="text-xs text-emerald-400">فعال (سرویس آماده)</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleToggleRoute(r.projectId, !r.caddyEnabled)}
                            className={`px-3 py-1 rounded-md text-xs font-medium cursor-pointer ${
                              r.caddyEnabled
                                ? 'bg-emerald-500/15 text-emerald-400'
                                : 'bg-slate-800 text-slate-400'
                            }`}
                          >
                            {r.caddyEnabled ? 'فعال در Caddy' : 'غیرفعال'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
