import { Check, Copy, Download, HardDriveDownload, ServerCog, Upload } from 'lucide-react';
import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { apiFetch } from '../api';

interface ProvisioningPageProps {
  onBackupRestored: () => void;
}

export function ProvisioningPage({ onBackupRestored }: ProvisioningPageProps) {
  const [panelDomain, setPanelDomain] = useState('panel.example.com');
  const [caddyEmail, setCaddyEmail] = useState('admin@example.com');
  const [dockerNetwork, setDockerNetwork] = useState('caddy_net');
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

  const [backupFeedback, setBackupFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null,
  );
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
  }, [panelDomain, caddyEmail, dockerNetwork, panelPort, includeBeszel, configureUfw]);

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
    try {
      const data = await apiFetch<Record<string, unknown>>('/api/backup/export');
      const dateStr = new Date().toISOString().slice(0, 10);
      handleDownloadFile(
        `sokanyar-backup-${dateStr}.json`,
        JSON.stringify(data, null, 2),
        'application/json',
      );
      setBackupFeedback({
        type: 'ok',
        text: 'فایل پشتیبان پروژه‌ها و تنظیمات Caddy با موفقیت دانلود شد.',
      });
    } catch (err) {
      setBackupFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'خطا در تهیه فایل پشتیبان',
      });
    }
  };

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setBackupFeedback(null);
    try {
      const text = await file.text();
      const json = JSON.parse(text) as unknown;
      const res = await apiFetch<{ importedCount: number }>('/api/backup/import', {
        method: 'POST',
        body: JSON.stringify(json),
      });
      setBackupFeedback({
        type: 'ok',
        text: `بازیابی انجام شد: ${res.importedCount} پروژه جدید اضافه شد و Caddyfile بازگردانی گردید.`,
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

      {/* Backup & Disaster Recovery */}
      <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-6 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-slate-100">
              بکاپ یکپارچه و بازیابی سریع روی سرور جدید
            </h2>
            <p className="text-xs text-slate-400">
              خروجی JSON شامل لیست کامل مخازن گیتهاب، دامنه‌ها، تنظیمات Webhook/Polling و Caddyfile کامل سرور است.
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0 flex-wrap">
            <button
              type="button"
              onClick={handleExportBackup}
              className="px-4 py-2 text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              <HardDriveDownload className="w-3.5 h-3.5" />
              دانلود بکاپ JSON
            </button>

            <label className="px-4 py-2 text-xs font-medium text-slate-200 bg-[#0B0F17] border border-[#1F2937] hover:border-slate-600 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap">
              <Upload className="w-3.5 h-3.5" />
              {importing ? 'در حال بازیابی...' : 'بازگردانی فایل بکاپ'}
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
            className={`rounded-lg px-4 py-2.5 text-xs border ${
              backupFeedback.type === 'ok'
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                : 'bg-red-500/10 border-red-500/20 text-red-400'
            }`}
          >
            {backupFeedback.text}
          </div>
        )}
      </div>
    </div>
  );
}
