import {
  Check,
  Copy,
  Database,
  Eye,
  EyeOff,
  Globe,
  Layers,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiFetch } from '../api';
import type { DeployedService, PrivateNetwork, ServiceTemplate } from '../types';

interface TemplatesPageProps {
  networks: PrivateNetwork[];
  onServiceChanged: () => void;
}

const CATEGORY_LABELS: Record<'all' | 'database' | 'app' | 'tool', string> = {
  all: 'همه سرویس‌ها',
  database: 'دیتابیس و کش',
  app: 'اپلیکیشن‌های آماده',
  tool: 'ابزارهای مدیریت',
};

export function TemplatesPage({ networks, onServiceChanged }: TemplatesPageProps) {
  const [templates, setTemplates] = useState<ServiceTemplate[]>([]);
  const [services, setServices] = useState<DeployedService[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'all' | 'database' | 'app' | 'tool'>('all');

  // Install modal state
  const [selectedTemplate, setSelectedTemplate] = useState<ServiceTemplate | null>(null);
  const [installName, setInstallName] = useState('');
  const [installSlug, setInstallSlug] = useState('');
  const [installDomain, setInstallDomain] = useState('');
  const [installNetworkId, setInstallNetworkId] = useState('');
  const [installCaddy, setInstallCaddy] = useState(true);
  const [installMemMb, setInstallMemMb] = useState(256);
  const [installEnv, setInstallEnv] = useState<Record<string, string>>({});
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState('');

  // Post-install generated secrets banner
  const [createdNotice, setCreatedNotice] = useState<{
    service: DeployedService;
    generatedEnv: Record<string, string>;
  } | null>(null);

  // Service row state
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [revealedIds, setRevealedIds] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [tpls, svcs] = await Promise.all([
        apiFetch<ServiceTemplate[]>('/api/templates'),
        apiFetch<DeployedService[]>('/api/services'),
      ]);
      setTemplates(tpls);
      setServices(svcs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در بارگذاری کاتالوگ سرویس‌های آماده');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const copyText = (key: string, value: string) => {
    void navigator.clipboard.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  const openInstallModal = (tpl: ServiceTemplate) => {
    setSelectedTemplate(tpl);
    setInstallName(tpl.name);
    // Avoid colliding with an already installed service using the default slug
    const existingSlugs = new Set(services.map((s) => s.slug));
    let candidateSlug = tpl.defaultSlug;
    let suffix = 2;
    while (existingSlugs.has(candidateSlug)) {
      candidateSlug = `${tpl.defaultSlug}-${suffix}`;
      suffix += 1;
    }
    setInstallSlug(candidateSlug);
    setInstallDomain('');
    setInstallNetworkId(networks[0]?.id ?? '');
    setInstallCaddy(tpl.supportsDomain);
    setInstallMemMb(tpl.defaultMemLimitMb);
    const initialEnv: Record<string, string> = {};
    for (const f of tpl.envFields) {
      initialEnv[f.key] = f.defaultValue ?? '';
    }
    setInstallEnv(initialEnv);
    setInstallError('');
  };

  const handleInstall = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedTemplate) return;
    setInstalling(true);
    setInstallError('');
    try {
      const res = await apiFetch<{
        service: DeployedService;
        generatedEnv: Record<string, string>;
      }>('/api/services', {
        method: 'POST',
        body: JSON.stringify({
          templateId: selectedTemplate.id,
          name: installName,
          slug: installSlug,
          domain: selectedTemplate.supportsDomain ? installDomain : '',
          privateNetworkId: installNetworkId || null,
          caddyEnabled: selectedTemplate.supportsDomain && installCaddy && Boolean(installDomain.trim()),
          memLimitMb: installMemMb,
          envVars: installEnv,
        }),
      });
      setSelectedTemplate(null);
      setCreatedNotice({ service: res.service, generatedEnv: res.generatedEnv });
      await loadAll();
      onServiceChanged();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : 'راه‌اندازی سرویس ناموفق بود');
    } finally {
      setInstalling(false);
    }
  };

  const handleServiceAction = async (id: string, action: 'start' | 'stop' | 'restart' | 'redeploy') => {
    setBusyId(id);
    setError('');
    try {
      await apiFetch(`/api/services/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      await loadAll();
      onServiceChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'اجرای عملیات روی سرویس ناموفق بود');
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteService = async (id: string) => {
    setBusyId(id);
    setError('');
    try {
      await apiFetch(`/api/services/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      await loadAll();
      onServiceChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'حذف سرویس ناموفق بود');
    } finally {
      setBusyId(null);
    }
  };

  const filteredTemplates = templates.filter((tpl) => {
    const q = search.trim().toLowerCase();
    const matchSearch =
      !q ||
      tpl.name.toLowerCase().includes(q) ||
      tpl.subtitle.toLowerCase().includes(q) ||
      tpl.description.toLowerCase().includes(q) ||
      tpl.image.toLowerCase().includes(q);
    const matchCategory = category === 'all' || tpl.category === category;
    return matchSearch && matchCategory;
  });

  const renderCategoryIcon = (cat: ServiceTemplate['category']) => {
    if (cat === 'database') return <Database className="w-4 h-4 text-sky-400 shrink-0" />;
    if (cat === 'tool') return <Wrench className="w-4 h-4 text-sky-400 shrink-0" />;
    return <Layers className="w-4 h-4 text-sky-400 shrink-0" />;
  };

  return (
    <div className="space-y-6">
      {/* Post-install Credentials Banner */}
      {createdNotice && (
        <div className="bg-[#111827] border border-emerald-500/40 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <h3 className="text-sm font-semibold text-emerald-400">
              سرویس «{createdNotice.service.name}» با موفقیت ثبت و راه‌اندازی شد
            </h3>
            <button
              type="button"
              onClick={() => setCreatedNotice(null)}
              className="text-slate-400 hover:text-slate-100 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {createdNotice.service.lastMessage && (
            <p className="text-xs text-slate-300">{createdNotice.service.lastMessage}</p>
          )}
          <div className="bg-[#0B0F17] border border-[#1F2937] rounded-lg p-3.5 space-y-2 text-xs">
            <div className="flex items-center justify-between gap-3">
              <div className="truncate font-mono text-sky-400" dir="ltr">
                {createdNotice.service.connectionUrl}
              </div>
              <button
                type="button"
                onClick={() => copyText('created-url', createdNotice.service.connectionUrl)}
                className="text-slate-400 hover:text-slate-100 shrink-0 cursor-pointer flex items-center gap-1"
              >
                {copiedKey === 'created-url' ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                <span>کپی آدرس</span>
              </button>
            </div>
            {Object.keys(createdNotice.generatedEnv).length > 0 && (
              <div className="pt-2 border-t border-[#1F2937] space-y-1 font-mono text-[11px] text-slate-300" dir="ltr">
                {Object.entries(createdNotice.generatedEnv).map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      <span className="text-slate-400">{k}=</span>
                      {v}
                    </span>
                    <button
                      type="button"
                      onClick={() => copyText(`env-${k}`, v)}
                      className="text-slate-500 hover:text-slate-200 shrink-0 cursor-pointer"
                    >
                      {copiedKey === `env-${k}` ? (
                        <Check className="w-3 h-3 text-emerald-400" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* Installed Services Section */}
      {services.length > 0 && (
        <section className="bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-[#1F2937] flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">سرویس‌های نصب‌شده روی سرور</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                دیتابیس‌ها و اپ‌های آماده روی شبکه خصوصی انتخاب‌شده یا شبکه <span className="font-mono text-slate-300">web</span> با Volume دائمی
              </p>
            </div>
            <button
              type="button"
              onClick={loadAll}
              className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-[#0B0F17] border border-[#1F2937] hover:border-slate-600 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              بروزرسانی
            </button>
          </div>

          <div className="divide-y divide-[#1F2937]">
            {services.map((svc) => {
              const isRunning = svc.status === 'running';
              const isDb = svc.category === 'database';
              const isRevealed = Boolean(revealedIds[svc.id]);
              return (
                <div
                  key={svc.id}
                  className="p-5 hover:bg-slate-800/20 transition-colors flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                >
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <h3 className="text-sm font-semibold text-slate-100">{svc.name}</h3>
                      <span
                        className={`text-xs font-medium ${
                          isRunning
                            ? 'text-emerald-400'
                            : svc.status === 'error'
                              ? 'text-red-400'
                              : 'text-slate-400'
                        }`}
                      >
                        {isRunning ? 'در حال اجرا' : svc.status === 'error' ? 'خطا' : 'متوقف'}
                      </span>
                    </div>

                    <div className="text-xs text-slate-400 flex items-center gap-2 flex-wrap font-mono tabular-nums">
                      <span className="text-slate-300">{svc.containerName}</span>
                      <span>·</span>
                      <span>{svc.image}</span>
                      <span>·</span>
                      <span>RAM ≤ {svc.memLimitMb}MB</span>
                      {svc.networks && svc.networks.length > 0 && (
                        <>
                          <span>·</span>
                          <span className="text-sky-400 font-sans">
                            شبکه: {svc.networks.map((n) => n.name).join('، ')}
                          </span>
                        </>
                      )}
                      {svc.domain && (
                        <>
                          <span>·</span>
                          <a
                            href={`https://${svc.domain}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-sky-400 hover:underline"
                          >
                            <Globe className="w-3 h-3" />
                            {svc.domain}
                          </a>
                        </>
                      )}
                    </div>

                    <div className="flex items-center gap-2 text-xs pt-0.5">
                      <span className="text-slate-500">
                        {isDb ? 'رشته اتصال داخلی:' : 'نشانی:'}
                      </span>
                      <code className="font-mono text-[11px] text-slate-300 truncate max-w-md" dir="ltr">
                        {isDb && !isRevealed ? `internal://${svc.internalHost} (کلیک برای نمایش رمز)` : svc.connectionUrl}
                      </code>
                      {isDb && (
                        <button
                          type="button"
                          onClick={() =>
                            setRevealedIds((prev) => ({ ...prev, [svc.id]: !prev[svc.id] }))
                          }
                          title={isRevealed ? 'مخفی کردن' : 'نمایش رشته اتصال کامل'}
                          className="text-slate-400 hover:text-slate-200 cursor-pointer"
                        >
                          {isRevealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => copyText(`svc-${svc.id}`, svc.connectionUrl)}
                        title="کپی رشته اتصال"
                        className="text-slate-400 hover:text-sky-400 cursor-pointer"
                      >
                        {copiedKey === `svc-${svc.id}` ? (
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                    {isRunning ? (
                      <button
                        type="button"
                        disabled={busyId === svc.id}
                        onClick={() => handleServiceAction(svc.id, 'stop')}
                        title="توقف"
                        className="p-2 rounded-lg bg-[#0B0F17] border border-[#1F2937] hover:border-amber-500/50 text-amber-400 cursor-pointer"
                      >
                        <Square className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busyId === svc.id}
                        onClick={() => handleServiceAction(svc.id, 'start')}
                        title="شروع"
                        className="p-2 rounded-lg bg-[#0B0F17] border border-[#1F2937] hover:border-emerald-500/50 text-emerald-400 cursor-pointer"
                      >
                        <Play className="w-3.5 h-3.5" />
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={busyId === svc.id}
                      onClick={() => handleServiceAction(svc.id, 'restart')}
                      title="ری‌استارت"
                      className="p-2 rounded-lg bg-[#0B0F17] border border-[#1F2937] hover:border-sky-500/50 text-sky-400 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>

                    <button
                      type="button"
                      disabled={busyId === svc.id}
                      onClick={() => handleServiceAction(svc.id, 'redeploy')}
                      className="px-3 py-2 text-xs font-medium text-slate-200 bg-[#0B0F17] border border-[#1F2937] hover:border-slate-600 rounded-lg cursor-pointer whitespace-nowrap"
                    >
                      {busyId === svc.id ? 'در حال اجرا...' : 'آپدیت ایمیج'}
                    </button>

                    {confirmDeleteId === svc.id ? (
                      <button
                        type="button"
                        disabled={busyId === svc.id}
                        onClick={() => handleDeleteService(svc.id)}
                        className="px-3 py-2 text-xs font-medium bg-red-500 text-white rounded-lg cursor-pointer whitespace-nowrap"
                      >
                        تایید حذف
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(svc.id)}
                        title="حذف سرویس"
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
        </section>
      )}

      {/* One-Click Catalog */}
      <section className="space-y-4">
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-xs">
            <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="جستجو PostgreSQL، Redis، n8n..."
              className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg pr-9 pl-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-500"
            />
          </div>

          <div className="flex items-center gap-1 p-1 bg-[#0B0F17] border border-[#1F2937] rounded-lg overflow-x-auto">
            {(['all', 'database', 'app', 'tool'] as const).map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  category === cat
                    ? 'bg-[#1F2937] text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {CATEGORY_LABELS[cat]}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <div key={n} className="h-44 bg-[#111827] border border-[#1F2937] rounded-xl animate-pulse" />
            ))}
          </div>
        ) : filteredTemplates.length === 0 ? (
          <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-10 text-center text-xs text-slate-400">
            سرویس آماده‌ای مطابق جستجو پیدا نشد.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredTemplates.map((tpl) => (
              <div
                key={tpl.id}
                className="bg-[#111827] border border-[#1F2937] rounded-xl p-5 flex flex-col justify-between gap-4 hover:border-slate-700 transition-colors"
              >
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      {renderCategoryIcon(tpl.category)}
                      <h3 className="text-sm font-semibold text-slate-100 truncate">{tpl.name}</h3>
                    </div>
                    <span className="text-[11px] text-slate-500 whitespace-nowrap shrink-0">
                      {CATEGORY_LABELS[tpl.category]}
                    </span>
                  </div>

                  <p className="text-xs text-slate-400 leading-relaxed">{tpl.description}</p>

                  <div className="text-[11px] text-slate-500 font-mono tabular-nums flex items-center gap-2 flex-wrap pt-1">
                    <span>{tpl.image}</span>
                    <span>·</span>
                    <span>:{tpl.containerPort}</span>
                    <span>·</span>
                    <span>{tpl.defaultMemLimitMb}MB</span>
                  </div>
                </div>

                <div className="pt-3 border-t border-[#1F2937] flex items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-400">
                    {tpl.supportsDomain ? 'دامنه و SSL خودکار' : 'شبکه داخلی ایزوله'}
                  </span>
                  <button
                    type="button"
                    onClick={() => openInstallModal(tpl)}
                    className="px-3.5 py-2 text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    نصب یک‌کلیکه
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Install Template Modal */}
      {selectedTemplate && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="w-full max-w-xl bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-[#1F2937] flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-slate-100">
                  نصب {selectedTemplate.name}
                </h2>
                <p className="text-xs text-slate-400 mt-0.5 font-mono">{selectedTemplate.image}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTemplate(null)}
                className="text-slate-400 hover:text-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleInstall} className="p-6 overflow-y-auto space-y-4 text-xs">
              {installError && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3.5 py-2.5 text-red-400">
                  {installError}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-300 mb-1">نام نمایشی</label>
                  <input
                    type="text"
                    required
                    value={installName}
                    onChange={(e) => setInstallName(e.target.value)}
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">شناسه کانتینر (انگلیسی)</label>
                  <input
                    type="text"
                    required
                    value={installSlug}
                    onChange={(e) => setInstallSlug(e.target.value)}
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                  />
                  <p className="mt-1 text-[11px] text-slate-500 font-mono">
                    host: sokkan-{installSlug || 'service'}:{selectedTemplate.containerPort}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-300 mb-1">سقف مصرف رم (مگابایت)</label>
                  <input
                    type="number"
                    min={64}
                    max={2048}
                    value={installMemMb}
                    onChange={(e) => setInstallMemMb(Number(e.target.value))}
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono tabular-nums focus:outline-none focus:border-sky-500"
                  />
                </div>

                {selectedTemplate.supportsDomain ? (
                  <div>
                    <label className="block text-slate-300 mb-1">دامنه عمومی در Caddy (اختیاری)</label>
                    <input
                      type="text"
                      value={installDomain}
                      onChange={(e) => setInstallDomain(e.target.value)}
                      placeholder={`${selectedTemplate.defaultSlug}.example.com`}
                      className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                    />
                  </div>
                ) : (
                  <div className="bg-[#0B0F17] border border-[#1F2937] rounded-lg p-3 text-[11px] text-slate-400 leading-relaxed">
                    این دیتابیس برای امنیت بیشتر فقط روی شبکه داخلی انتخاب‌شده اجرا می‌شود و روی اینترنت باز نمی‌شود.
                  </div>
                )}
              </div>

              <div>
                <label className="block text-slate-300 mb-1">شبکه خصوصی / شبکه اجرایی</label>
                <select
                  value={installNetworkId}
                  onChange={(e) => setInstallNetworkId(e.target.value)}
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

              {selectedTemplate.supportsDomain && (
                <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={installCaddy}
                    onChange={(e) => setInstallCaddy(e.target.checked)}
                    className="accent-sky-500"
                  />
                  ثبت خودکار مسیر Reverse Proxy و صدور SSL در Caddyfile
                </label>
              )}

              {selectedTemplate.envFields.length > 0 && (
                <div className="pt-3 border-t border-[#1F2937] space-y-3">
                  <div className="text-slate-200 font-medium">
                    تنظیمات و متغیرهای سرویس (فیلدهای رمز را خالی بگذارید تا خودکار تولید شوند)
                  </div>
                  {selectedTemplate.envFields.map((field) => (
                    <div key={field.key}>
                      <label className="block text-slate-300 mb-1">
                        {field.label}{' '}
                        <span className="font-mono text-[11px] text-slate-500">({field.key})</span>
                      </label>
                      <input
                        type={field.secret ? 'password' : 'text'}
                        value={installEnv[field.key] ?? ''}
                        onChange={(e) =>
                          setInstallEnv((prev) => ({ ...prev, [field.key]: e.target.value }))
                        }
                        placeholder={
                          field.autoGenerate
                            ? 'خالی بگذارید برای تولید خودکار رمز امن'
                            : field.placeholder || field.defaultValue || ''
                        }
                        className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="pt-4 border-t border-[#1F2937] flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setSelectedTemplate(null)}
                  className="px-4 py-2 text-slate-300 hover:text-slate-100 cursor-pointer"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  disabled={installing}
                  className="px-5 py-2 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-semibold rounded-lg cursor-pointer"
                >
                  {installing ? 'در حال دریافت ایمیج و اجرا...' : 'نصب و راه‌اندازی سرویس'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
