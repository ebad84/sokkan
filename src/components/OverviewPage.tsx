import { Activity, ArrowUpLeft, CheckCircle2, Cpu, Database, HardDrive, RefreshCw, Server, Terminal } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { apiFetch } from '../api';
import type { BeszelConfig, Deployment, NavTab, Project, SystemStatus } from '../types';

interface OverviewPageProps {
  status: SystemStatus | null;
  loading: boolean;
  projects: Project[];
  deployments: Deployment[];
  beszelConfig: BeszelConfig | null;
  onRefresh: () => void;
  onNavigate: (tab: NavTab) => void;
  onInspectDeployment: (deploymentId: string) => void;
  onBeszelSaved: () => void;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} روز و ${hours} ساعت`;
  if (hours > 0) return `${hours} ساعت و ${mins} دقیقه`;
  return `${mins} دقیقه`;
}

function TelemetryChart({
  points,
}: {
  points: Array<{ label: string; cpu: number; mem: number }>;
}) {
  if (points.length < 2) {
    return (
      <div className="h-44 flex items-center justify-center text-xs text-slate-400 border border-dashed border-[#1F2937] rounded-lg">
        در حال جمع‌آوری نمونه‌های اولیه مصرف منابع (هر ۶۰ ثانیه یک نمونه ثبت می‌شود)...
      </div>
    );
  }

  const width = 640;
  const height = 160;
  const padX = 12;
  const padY = 14;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  const toPolyline = (values: number[]) =>
    values
      .map((v, i) => {
        const x = padX + (i / Math.max(1, values.length - 1)) * plotW;
        const clamped = Math.max(0, Math.min(100, v));
        const y = padY + plotH - (clamped / 100) * plotH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  const cpuPoints = toPolyline(points.map((p) => p.cpu));
  const memPoints = toPolyline(points.map((p) => p.mem));

  return (
    <div className="space-y-3">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-44 bg-[#0B0F17] border border-[#1F2937] rounded-lg"
        role="img"
        aria-label="نمودار تاریخچه مصرف پردازنده و حافظه"
      >
        {[25, 50, 75].map((pct) => {
          const y = padY + plotH - (pct / 100) * plotH;
          return (
            <line
              key={pct}
              x1={padX}
              y1={y}
              x2={width - padX}
              y2={y}
              stroke="#1F2937"
              strokeDasharray="4 4"
              strokeWidth="1"
            />
          );
        })}
        <polyline
          fill="none"
          stroke="#0EA5E9"
          strokeWidth="2"
          strokeLinejoin="round"
          points={cpuPoints}
        />
        <polyline
          fill="none"
          stroke="#10B981"
          strokeWidth="2"
          strokeLinejoin="round"
          points={memPoints}
        />
      </svg>
      <div className="flex items-center justify-between text-xs text-slate-400">
        <div className="flex items-center gap-5">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-sky-500 inline-block" />
            مصرف CPU (%)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-emerald-500 inline-block" />
            مصرف RAM (%)
          </span>
        </div>
        <span className="font-mono tabular-nums">{points.length} نمونه اخیر</span>
      </div>
    </div>
  );
}

export function OverviewPage({
  status,
  loading,
  projects,
  deployments,
  beszelConfig,
  onRefresh,
  onNavigate,
  onInspectDeployment,
  onBeszelSaved,
}: OverviewPageProps) {
  const [showBeszelForm, setShowBeszelForm] = useState(false);
  const [beszelEnabled, setBeszelEnabled] = useState(beszelConfig?.enabled ?? false);
  const [beszelUrl, setBeszelUrl] = useState(beszelConfig?.url ?? '');
  const [beszelEmail, setBeszelEmail] = useState(beszelConfig?.email ?? '');
  const [beszelPassword, setBeszelPassword] = useState('');
  const [savingBeszel, setSavingBeszel] = useState(false);
  const [beszelMsg, setBeszelMsg] = useState('');
  const [beszelErr, setBeszelErr] = useState('');

  const handleSaveBeszel = async (e: FormEvent) => {
    e.preventDefault();
    setSavingBeszel(true);
    setBeszelErr('');
    setBeszelMsg('');
    try {
      const res = await apiFetch<{ telemetry: { connected: boolean; error?: string } }>(
        '/api/integrations/beszel',
        {
          method: 'POST',
          body: JSON.stringify({
            enabled: beszelEnabled,
            url: beszelUrl,
            email: beszelEmail,
            password: beszelPassword || undefined,
          }),
        },
      );
      setBeszelPassword('');
      if (res.telemetry.error) {
        setBeszelErr(res.telemetry.error);
      } else {
        setBeszelMsg(
          res.telemetry.connected
            ? 'اتصال به سرور Beszel برقرار شد و تاریخچه منابع همگام‌سازی شد.'
            : 'تنظیمات ذخیره شد.',
        );
      }
      onBeszelSaved();
    } catch (err) {
      setBeszelErr(err instanceof Error ? err.message : 'خطا در ذخیره تنظیمات Beszel');
    } finally {
      setSavingBeszel(false);
    }
  };

  if (loading && !status) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 bg-[#111827] border border-[#1F2937] rounded-xl animate-pulse" />
          ))}
        </div>
        <div className="h-64 bg-[#111827] border border-[#1F2937] rounded-xl animate-pulse" />
      </div>
    );
  }

  const host = status?.hostMetrics;
  const beszelHistory = status?.beszel?.connected ? status.beszel.history : [];
  const chartPoints =
    beszelHistory.length >= 2
      ? beszelHistory.map((h) => ({ label: h.created, cpu: h.cpu, mem: h.memPercent }))
      : (status?.recentSamples ?? []).map((s) => ({
          label: s.sampled_at,
          cpu: s.cpu_percent,
          mem: s.mem_percent,
        }));

  const projectMap = new Map(projects.map((p) => [p.id, p]));

  return (
    <div className="space-y-6">
      {/* Execution Mode Banner */}
      <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Server className="w-4 h-4 text-sky-400" />
            <span>
              {status?.executionMode === 'vps'
                ? 'حالت عملیاتی VPS فعال است (اتصال مستقیم به Docker و Git)'
                : 'حالت پیش‌نمایش و آماده‌سازی سرور (سوکت داکر در این محیط متصل نیست)'}
            </span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            {status?.executionMode === 'vps'
              ? `میزبان ${host?.hostname ?? ''} · کنترل کامل کانتینرها جایگزین Portainer شده و Caddy ${status.capabilities.caddyReachable ? 'متصل است' : 'در انتظار اتصال است'}.`
              : 'می‌توانید مخازن گیتهاب را به صورت واقعی بررسی کنید، Caddyfile را تنظیم نمایید و اسکریپت راه‌اندازی کامل سرور را دریافت کنید تا روی VPS اجرا شود.'}
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onRefresh}
            className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#0B0F17] border border-[#1F2937] hover:border-slate-600 rounded-lg transition-colors flex items-center gap-2 cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            بروزرسانی وضعیت
          </button>
          <button
            type="button"
            onClick={() => onNavigate('provisioning')}
            className="px-4 py-2 text-xs font-semibold text-slate-950 bg-sky-500 hover:bg-sky-400 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            اسکریپت نصب روی VPS
            <ArrowUpLeft className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
            <span>پردازنده (CPU)</span>
            <Cpu className="w-4 h-4 text-sky-400" />
          </div>
          <div className="text-2xl font-semibold text-slate-100 font-mono tabular-nums">
            {host ? `${host.cpuLoadPercent}%` : '—'}
          </div>
          <div className="text-xs text-slate-400 mt-1.5 font-mono tabular-nums">
            {host ? `${host.cpuCores} هسته · بار ۱دقیقه‌ای ${host.loadAvg1m}` : ''}
          </div>
        </div>

        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
            <span>حافظه رم (RAM)</span>
            <Activity className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-semibold text-slate-100 font-mono tabular-nums">
            {host ? `${host.memPercent}%` : '—'}
          </div>
          <div className="text-xs text-slate-400 mt-1.5 font-mono tabular-nums">
            {host ? `${host.memUsedMb} / ${host.memTotalMb} MB` : ''}
          </div>
        </div>

        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
            <span>فضای دیسک ریشه</span>
            <HardDrive className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-semibold text-slate-100 font-mono tabular-nums">
            {host ? `${host.diskPercent}%` : '—'}
          </div>
          <div className="text-xs text-slate-400 mt-1.5 font-mono tabular-nums">
            {host ? `${host.diskUsedGb} / ${host.diskTotalGb} GB` : ''}
          </div>
        </div>

        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
            <span>آپتایم و سرویس‌ها</span>
            <Database className="w-4 h-4 text-slate-300" />
          </div>
          <div className="text-lg font-semibold text-slate-100 tabular-nums">
            {host ? formatUptime(host.uptimeSeconds) : '—'}
          </div>
          <div className="text-xs text-slate-400 mt-2 tabular-nums">
            {projects.length} پروژه تعریف‌شده · {deployments.length} دیپلوی اخیر
          </div>
        </div>
      </div>

      {/* Resource Telemetry + Optional Beszel API */}
      <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              روند مصرف منابع سرور
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {status?.beszel?.connected
                ? 'منبع داده: API تاریخچه Beszel Hub'
                : 'منبع داده: پایشگر داخلی سرور (با امکان اتصال اختیاری به Beszel)'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowBeszelForm((v) => !v)}
            className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#0B0F17] border border-[#1F2937] hover:border-sky-500/50 rounded-lg transition-colors cursor-pointer whitespace-nowrap self-start"
          >
            {status?.beszel?.connected ? 'تنظیمات اتصال Beszel (متصل)' : 'اتصال به API ابزار Beszel'}
          </button>
        </div>

        {showBeszelForm && (
          <form
            onSubmit={handleSaveBeszel}
            className="bg-[#0B0F17] border border-[#1F2937] rounded-lg p-4 space-y-4"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-200">
                پیکربندی اختیاری Beszel Hub API
              </span>
              <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={beszelEnabled}
                  onChange={(e) => setBeszelEnabled(e.target.checked)}
                  className="accent-sky-500"
                />
                فعال‌سازی خواندن تاریخچه از Beszel
              </label>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">آدرس Beszel Hub</label>
                <input
                  type="url"
                  value={beszelUrl}
                  onChange={(e) => setBeszelUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8090"
                  className="w-full bg-[#111827] border border-[#1F2937] rounded-lg px-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">ایمیل حساب Beszel</label>
                <input
                  type="email"
                  value={beszelEmail}
                  onChange={(e) => setBeszelEmail(e.target.value)}
                  placeholder="admin@example.com"
                  className="w-full bg-[#111827] border border-[#1F2937] rounded-lg px-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  رمز عبور {beszelConfig?.hasPassword ? '(ذخیره شده - برای تغییر وارد کنید)' : ''}
                </label>
                <input
                  type="password"
                  value={beszelPassword}
                  onChange={(e) => setBeszelPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-[#111827] border border-[#1F2937] rounded-lg px-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>
            {beszelErr && <div className="text-xs text-red-400">{beszelErr}</div>}
            {beszelMsg && <div className="text-xs text-emerald-400">{beszelMsg}</div>}
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={savingBeszel}
                className="px-4 py-2 text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
              >
                {savingBeszel ? 'در حال تست و ذخیره...' : 'ذخیره و آزمایش اتصال'}
              </button>
            </div>
          </form>
        )}

        <TelemetryChart points={chartPoints} />

        {status?.beszel?.connected && status.beszel.systems.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 border-t border-[#1F2937]">
            {status.beszel.systems.map((sys) => (
              <div
                key={sys.id}
                className="bg-[#0B0F17] border border-[#1F2937] rounded-lg p-3.5 flex items-center justify-between text-xs"
              >
                <div>
                  <div className="font-semibold text-slate-100">{sys.name}</div>
                  <div className="text-slate-400 font-mono mt-0.5">{sys.host}</div>
                </div>
                <div className="text-left font-mono tabular-nums text-slate-300">
                  <div>CPU {sys.cpu}%</div>
                  <div className="text-slate-400">RAM {sys.memPercent}%</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Deployments */}
      <div className="bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-[#1F2937] flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-100">تاریخچه آخرین دیپلوی‌ها</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              رویدادهای بیلد خودکار از طریق Webhook، Polling دوره‌ای یا اجرای دستی
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('projects')}
            className="text-xs font-medium text-sky-400 hover:text-sky-300 cursor-pointer whitespace-nowrap"
          >
            مدیریت پروژه‌ها
          </button>
        </div>

        {deployments.length === 0 ? (
          <div className="p-8 text-center space-y-3">
            <p className="text-sm text-slate-400">هنوز هیچ دیپلویی اجرا نشده است.</p>
            <button
              type="button"
              onClick={() => onNavigate('projects')}
              className="px-4 py-2 text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 rounded-lg cursor-pointer"
            >
              اتصال اولین مخزن گیتهاب
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-right">
              <thead className="bg-[#0B0F17] text-slate-400 border-b border-[#1F2937]">
                <tr>
                  <th className="py-3 px-4 font-medium">پروژه</th>
                  <th className="py-3 px-4 font-medium">محرک</th>
                  <th className="py-3 px-4 font-medium">کامیت</th>
                  <th className="py-3 px-4 font-medium">وضعیت</th>
                  <th className="py-3 px-4 font-medium">زمان شروع</th>
                  <th className="py-3 px-4 font-medium text-left">لاگ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1F2937]">
                {deployments.slice(0, 8).map((dep) => {
                  const proj = projectMap.get(dep.project_id);
                  const statusLabel =
                    dep.status === 'success'
                      ? 'موفق'
                      : dep.status === 'failed'
                        ? 'ناموفق'
                        : 'در حال ساخت';
                  const statusColor =
                    dep.status === 'success'
                      ? 'text-emerald-400'
                      : dep.status === 'failed'
                        ? 'text-red-400'
                        : 'text-amber-400';

                  return (
                    <tr key={dep.id} className="hover:bg-slate-800/30 transition-colors">
                      <td className="py-3 px-4 font-medium text-slate-100">
                        {proj ? proj.name : dep.project_id}
                      </td>
                      <td className="py-3 px-4 text-slate-400">
                        {dep.trigger_type === 'webhook'
                          ? 'Webhook گیتهاب'
                          : dep.trigger_type === 'polling'
                            ? 'بررسی دوره‌ای'
                            : 'اجرای دستی'}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-300 tabular-nums">
                        {dep.commit_sha ? dep.commit_sha.slice(0, 7) : '—'}
                      </td>
                      <td className={`py-3 px-4 font-medium ${statusColor}`}>
                        <span className="inline-flex items-center gap-1.5">
                          {dep.status === 'success' && <CheckCircle2 className="w-3.5 h-3.5" />}
                          {statusLabel}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-400 tabular-nums">
                        {new Date(dep.started_at).toLocaleString('fa-IR')}
                      </td>
                      <td className="py-3 px-4 text-left">
                        <button
                          type="button"
                          onClick={() => onInspectDeployment(dep.id)}
                          className="inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 cursor-pointer whitespace-nowrap"
                        >
                          <Terminal className="w-3.5 h-3.5" />
                          مشاهده لاگ
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
