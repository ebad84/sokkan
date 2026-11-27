import { Check, Copy, Download, HardDriveDownload, Lock, ServerCog, ShieldCheck, Upload } from 'lucide-react';
import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { apiFetch, setAuthToken } from '../api';

interface ProvisioningPageProps {
  onBackupRestored: () => void;
}

export function ProvisioningPage({ onBackupRestored }: ProvisioningPageProps) {
  const [panelDomain, setPanelDomain] = useState('panel.ceqom.ir');
  const [caddyEmail, setCaddyEmail] = useState('admin@ceqom.ir');
  const [basicAuthUser, setBasicAuthUser] = useState('admin');
  const [dockerNetwork, setDockerNetwork] = useState('web');
  const [panelPort, setPanelPort] = useState(3000);
  const [includeBeszel, setIncludeBeszel] = useState(true);
  const [configureUfw, setConfigureUfw] = useState(true);

  const [generated, setGenerated] = useState<{
    bootstrapScript: string;
    dockerComposeYaml: string;
    dockerfile: string;
  } | null>(null);
  const [activeFile, setActiveFile] = useState<'bootstrap' | 'compose' | 'dockerfile'>('bootstrap');
  const [copied, setCopied] = useState(false);

  const [backupFeedback, setBackupFeedback] = useState<{
    type: 'ok' | 'err';
    text: string;
    warnings?: string[];
  } | null>(null);
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importMode, setImportMode] = useState<'replace' | 'merge'>('replace');
  const [redeployServices, setRedeployServices] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  const generateBundle = useCallback(async () => {
    try {
      const res = await apiFetch<{
        bootstrapScript: string;
        dockerComposeYaml: string;
        dockerfile: string;
      }>('/api/provisioning/generate', {
        method: 'POST',
        body: JSON.stringify({
          panelDomain,
          caddyEmail,
          basicAuthUser,
          dockerNetwork,
          panelPort,
          includeBeszel,
          configureUfw,
        }),
      });
      setGenerated(res);
    } catch {
      // Ignore transient validation error while typing
    }
  }, [panelDomain, caddyEmail, basicAuthUser, dockerNetwork, panelPort, includeBeszel, configureUfw]);

  useEffect(() => {
    void generateBundle();
  }, [generateBundle]);

  const activeText =
    activeFile === 'bootstrap'
      ? generated?.bootstrapScript ?? ''
      : activeFile === 'compose'
        ? generated?.dockerComposeYaml ?? ''
        : generated?.dockerfile ?? '';

  const activeFilename =
    activeFile === 'bootstrap'
      ? 'bootstrap-vps.sh'
      : activeFile === 'compose'
        ? 'docker-compose.yml'
        : 'Dockerfile';

  const handleCopy = () => {
    void navigator.clipboard.writeText(activeText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleDownloadFile = (filename: string, content: string, mime = 'text/plain') => {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportBackup = async () => {
    setBackupFeedback(null);
    setExporting(true);
    try {
      const pass = exportPassphrase.trim();
      if (pass && pass.length < 6) {
        throw new Error('رمز رمزنگاری فایل پشتیبان باید حداقل ۶ کاراکتر باشد (یا برای خروجی بدون رمز آن را خالی بگذارید).');
      }
      const data = await apiFetch<Record<string, unknown>>('/api/backup/export', {
        method: 'POST',
        body: JSON.stringify({ passphrase: pass || undefined }),
      });
      const dateStr = new Date().toISOString().slice(0, 10);
      const suffix = pass ? '-encrypted' : '-full';
      handleDownloadFile(
        `sokkan-backup-${dateStr}${suffix}.json`,
        JSON.stringify(data, null, 2),
        'application/json',
      );
      setBackupFeedback({
        type: 'ok',
        text: pass
          ? 'فایل پشتیبان کامل (شامل کاربران، رمزها، توکن‌ها، متغیرهای محیطی، شبکه‌های خصوصی، سرویس‌ها، Beszel و Caddyfile) با رمزنگاری AES-256-GCM دانلود شد.'
          : 'فایل پشتیبان کامل JSON (شامل تمام تنظیمات، کاربران، توکن‌ها، متغیرهای محیطی و رمزها) دانلود شد. آن را در جای امن نگهداری کنید.',
      });
    } catch (err) {
      setBackupFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'خطا در تهیه فایل پشتیبان',
      });
    } finally {
      setExporting(false);
    }
  };

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setBackupFeedback(null);
    try {
      const text = await file.text();
      const json = JSON.parse(text) as Record<string, unknown>;
      const res = await apiFetch<{
        ok: boolean;
        importedCount: number;
        mode: 'replace' | 'merge';
        restored?: {
          users: number;
          privateNetworks: number;
          networkAttachments: number;
          services: number;
          projects: number;
          caddySnapshots: number;
          beszelRestored: boolean;
          caddyfileRestored: boolean;
          servicesRedeployed: number;
        };
        warnings?: string[];
        token?: string;
      }>('/api/backup/import', {
        method: 'POST',
        body: JSON.stringify({
          backup: json,
          passphrase: importPassphrase.trim() || undefined,
          mode: importMode,
          redeployServices,
        }),
      });
      if (res.token) {
        setAuthToken(res.token);
      }
      const r = res.restored;
      const summaryText = r
        ? `بازیابی کامل (${res.mode === 'replace' ? 'جایگزینی کامل' : 'ادغام'}) انجام شد: ${r.users} کاربر، ${r.privateNetworks} شبکه خصوصی، ${r.services} سرویس آماده، ${r.projects} پروژه (با توکن، وب‌هوک و Env کامل)${r.beszelRestored ? '، تنظیمات و رمز Beszel' : ''}${r.caddyfileRestored ? ' و Caddyfile' : ''} بازگردانی شد${r.servicesRedeployed > 0 ? ` (${r.servicesRedeployed} سرویس روی سرور استارت شد)` : ''}.`
        : `بازیابی انجام شد: ${res.importedCount} پروژه بازیابی شد.`;
      setBackupFeedback({
        type: 'ok',
        text: summaryText,
        warnings: res.warnings && res.warnings.length > 0 ? res.warnings : undefined,
      });
      onBackupRestored();
    } catch (err) {
      setBackupFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'فایل پشتیبان نامعتبر است.',
      });
    } finally {
      setImporting(false);
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-6">
      {/* Architecture Strategy Summary */}
      <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-6 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <ServerCog className="w-4 h-4 text-sky-400" />
          <span>معماری پیشنهادی برای ساخت سرور تمیز از صفر</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-slate-300 leading-relaxed pt-1">
          <div className="bg-[#0B0F17] border border-[#1F2937] rounded-lg p-4 space-y-1">
            <div className="font-semibold text-red-400">حذف Portainer</div>
            <p className="text-slate-400">
              به دلیل اتصال مستقیم این پنل به سوکت داکر، دیگر نیازی به نصب Portainer نیست و حدود ۱۵۰ تا ۲۵۰ مگابایت رم صرفه‌جویی می‌شود.
            </p>
          </div>
          <div className="bg-[#0B0F17] border border-[#1F2937] rounded-lg p-4 space-y-1">
            <div className="font-semibold text-sky-400">حفظ Caddy + شبکه مشترک</div>
            <p className="text-slate-400">
              کانتینرها روی شبکه <code className="text-slate-200">{dockerNetwork}</code> اجرا می‌شوند و Caddy تنها با یک Reload بدون قطعی ترافیک SSL را هدایت می‌کند.
            </p>
          </div>
          <div className="bg-[#0B0F17] border border-[#1F2937] rounded-lg p-4 space-y-1">
            <div className="font-semibold text-emerald-400">نگهداری اختیاری Beszel</div>
            <p className="text-slate-400">
              با تیک زدن گزینه Beszel در زیر، هاب و ایجنت بسیار سبک آن هم در Compose سرور قرار می‌گیرد تا نمودارهای بلندمدت داخل داشبورد نمایش داده شوند.
            </p>
          </div>
        </div>
      </div>

      {/* Bootstrap Customizer + Code Viewer */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5 space-y-4 text-xs">
          <h2 className="text-sm font-semibold text-slate-100">پارامترهای اسکریپت راه‌اندازی</h2>

          <div>
            <label className="block text-slate-300 mb-1">دامنه اختصاصی پنل</label>
            <input
              type="text"
              value={panelDomain}
              onChange={(e) => setPanelDomain(e.target.value)}
              className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
            />
          </div>

          <div>
            <label className="block text-slate-300 mb-1">ایمیل صدور گواهی SSL در Caddy</label>
            <input
              type="email"
              value={caddyEmail}
              onChange={(e) => setCaddyEmail(e.target.value)}
              className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
            />
          </div>

          <div>
            <label className="block text-slate-300 mb-1">نام کاربری Caddy Basic Auth</label>
            <input
              type="text"
              value={basicAuthUser}
              onChange={(e) => setBasicAuthUser(e.target.value)}
              className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-300 mb-1">شبکه داکر</label>
              <input
                type="text"
                value={dockerNetwork}
                onChange={(e) => setDockerNetwork(e.target.value)}
                className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
              />
            </div>
            <div>
              <label className="block text-slate-300 mb-1">پورت پنل</label>
              <input
                type="number"
                value={panelPort}
                onChange={(e) => setPanelPort(Number(e.target.value))}
                className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono tabular-nums focus:outline-none focus:border-sky-500"
              />
            </div>
          </div>

          <div className="space-y-2.5 pt-2 border-t border-[#1F2937]">
            <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={configureUfw}
                onChange={(e) => setConfigureUfw(e.target.checked)}
                className="accent-sky-500"
              />
              پیکربندی خودکار فایروال UFW (22, 80, 443)
            </label>

            <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={includeBeszel}
                onChange={(e) => setIncludeBeszel(e.target.checked)}
                className="accent-sky-500"
              />
              شامل سرویس‌های Beszel Hub + Agent
            </label>
          </div>
        </div>

        <div className="lg:col-span-2 bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-[#1F2937] flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 p-1 bg-[#0B0F17] border border-[#1F2937] rounded-lg">
              {(
                [
                  { id: 'bootstrap', label: 'bootstrap-vps.sh' },
                  { id: 'compose', label: 'docker-compose.yml' },
                  { id: 'dockerfile', label: 'Dockerfile' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveFile(tab.id)}
                  className={`px-3 py-1.5 text-xs font-mono rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                    activeFile === tab.id
                      ? 'bg-[#1F2937] text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCopy}
                className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#0B0F17] border border-[#1F2937] hover:border-slate-600 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'کپی شد' : 'کپی'}
              </button>
              <button
                type="button"
                onClick={() => handleDownloadFile(activeFilename, activeText)}
                className="px-3.5 py-1.5 text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                دانلود فایل
              </button>
            </div>
          </div>

          <pre className="p-5 bg-[#0B0F17] text-xs font-mono text-slate-300 overflow-auto max-h-[420px] leading-relaxed">
            {activeText}
          </pre>
        </div>
      </div>

      {/* Full Backup & Disaster Recovery */}
      <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-6 space-y-5">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-sky-400" />
            <h2 className="text-base font-semibold text-slate-100">
              بکاپ کامل و بازیابی بدون افت داده (نصب مجدد روی سرور جدید)
            </h2>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            این بکاپ نسخه ۲ شامل <strong className="text-slate-200">تمام داده‌ها و کلیدهای امنیتی</strong> است: حساب‌های کاربری و هش رمز عبور، شبکه‌های خصوصی و اتصالات، پروژه‌ها همراه با شناسه ثابت وب‌هوک، توکن‌های گیتهاب، کلیدهای Webhook و تمام متغیرهای <code className="text-slate-200">.env</code>، سرویس‌های آماده و رمز دیتابیس‌ها، تنظیمات و رمز Beszel، و Caddyfile به همراه تاریخچه اسنپ‌شات‌ها. حتی با تغییر کلید رمزنگاری سرور جدید، تمام سکرت‌ها به‌طور خودکار با کلید جدید رمزنگاری و بازیابی می‌شوند.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Export Card */}
          <div className="bg-[#0B0F17] border border-[#1F2937] rounded-xl p-4 space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-100">تهیه خروجی کامل (Export)</span>
              <span className="text-[11px] text-emerald-400 font-mono">schema v2 + secrets</span>
            </div>
            <div>
              <label className="block text-slate-300 mb-1">
                رمز رمزنگاری فایل بکاپ (پیشنهادی برای محافظت از توکن‌ها و رمزها)
              </label>
              <div className="relative">
                <Lock className="w-3.5 h-3.5 text-slate-500 absolute right-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  value={exportPassphrase}
                  onChange={(e) => setExportPassphrase(e.target.value)}
                  placeholder="حداقل ۶ کاراکتر (یا خالی برای خروجی JSON بدون رمز)"
                  className="w-full bg-[#111827] border border-[#1F2937] rounded-lg pr-9 pl-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>
            <button
              type="button"
              disabled={exporting}
              onClick={handleExportBackup}
              className="w-full justify-center px-4 py-2.5 text-xs font-semibold bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 rounded-lg flex items-center gap-1.5 cursor-pointer"
            >
              <HardDriveDownload className="w-4 h-4" />
              {exporting
                ? 'در حال آماده‌سازی بکاپ...'
                : exportPassphrase.trim()
                  ? 'دانلود بکاپ کامل رمزنگاری‌شده'
                  : 'دانلود بکاپ کامل JSON'}
            </button>
          </div>

          {/* Import Card */}
          <div className="bg-[#0B0F17] border border-[#1F2937] rounded-xl p-4 space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-100">بازگردانی فایل بکاپ (Import)</span>
              <span className="text-[11px] text-slate-400 font-mono">v1 / v2 / encrypted</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label className="block text-slate-300 mb-1">حالت بازیابی</label>
                <select
                  value={importMode}
                  onChange={(e) => setImportMode(e.target.value === 'merge' ? 'merge' : 'replace')}
                  className="w-full bg-[#111827] border border-[#1F2937] rounded-lg px-2.5 py-2 text-slate-100 focus:outline-none focus:border-sky-500"
                >
                  <option value="replace">جایگزینی کامل (نصب مجدد)</option>
                  <option value="merge">ادغام با داده‌های فعلی</option>
                </select>
              </div>
              <div>
                <label className="block text-slate-300 mb-1">رمز بازگشایی (در صورت رمزنگاری)</label>
                <input
                  type="password"
                  value={importPassphrase}
                  onChange={(e) => setImportPassphrase(e.target.value)}
                  placeholder="رمز تعیین‌شده هنگام بکاپ"
                  className="w-full bg-[#111827] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={redeployServices}
                onChange={(e) => setRedeployServices(e.target.checked)}
                className="accent-sky-500"
              />
              اجرای خودکار کانتینر سرویس‌های آماده (دیتابیس‌ها/ابزارها) روی VPS پس از بازیابی
            </label>

            <label className="w-full justify-center px-4 py-2.5 text-xs font-medium text-slate-100 bg-[#111827] border border-[#1F2937] hover:border-sky-500/50 rounded-lg flex items-center gap-1.5 cursor-pointer">
              <Upload className="w-4 h-4 text-sky-400" />
              {importing ? 'در حال رمزگشایی و بازیابی...' : 'انتخاب و بازگردانی فایل بکاپ JSON'}
              <input
                type="file"
                accept="application/json,.json"
                onChange={handleImportFile}
                disabled={importing}
                className="hidden"
              />
            </label>
          </div>
        </div>

        {backupFeedback && (
          <div
            className={`rounded-lg px-4 py-3 text-xs border space-y-2 ${
              backupFeedback.type === 'ok'
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
                : 'bg-red-500/10 border-red-500/20 text-red-400'
            }`}
          >
            <div>{backupFeedback.text}</div>
            {backupFeedback.warnings && backupFeedback.warnings.length > 0 && (
              <ul className="list-disc pr-4 space-y-1 text-amber-300">
                {backupFeedback.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
