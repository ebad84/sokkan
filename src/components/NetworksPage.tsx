import {
  Check,
  Copy,
  Database,
  GitBranch,
  Key,
  Link2,
  Lock,
  Network,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
  Unlink,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { apiFetch } from '../api';
import type {
  DeployedService,
  NavTab,
  NetworkProbeResult,
  PrivateNetwork,
  Project,
} from '../types';

interface NetworksPageProps {
  projects: Project[];
  isAdmin: boolean;
  onNetworksChanged: () => void;
  onNavigate: (tab: NavTab) => void;
  onInspectDeployment: (deploymentId: string) => void;
}

function toNetworkSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function suggestEnvVarKey(
  sourceType: 'service' | 'project',
  sourceItem: DeployedService | Project | undefined,
): string {
  if (!sourceItem) return 'SERVICE_URL';
  if (sourceType === 'service') {
    const svc = sourceItem as DeployedService;
    if (svc.templateId === 'postgres' || svc.templateId === 'mariadb') return 'DATABASE_URL';
    if (svc.templateId === 'redis') return 'REDIS_URL';
    if (svc.templateId === 'mongodb') return 'MONGODB_URI';
  }
  return `${sourceItem.slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_URL`;
}

export function NetworksPage({
  projects,
  isAdmin,
  onNetworksChanged,
  onNavigate,
  onInspectDeployment,
}: NetworksPageProps) {
  const [networks, setNetworks] = useState<PrivateNetwork[]>([]);
  const [services, setServices] = useState<DeployedService[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');

  // Create modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createSlug, setCreateSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [createDescription, setCreateDescription] = useState('');
  const [createSubnet, setCreateSubnet] = useState('');
  const [createInternalOnly, setCreateInternalOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Attach inline state per network
  const [attachSelection, setAttachSelection] = useState<Record<string, string>>({});
  const [attachingNetId, setAttachingNetId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Inject env modal state
  const [injectModalNet, setInjectModalNet] = useState<PrivateNetwork | null>(null);
  const [injectSourceVal, setInjectSourceVal] = useState('');
  const [injectTargetProjectId, setInjectTargetProjectId] = useState('');
  const [injectEnvKey, setInjectEnvKey] = useState('DATABASE_URL');
  const [injectRedeploy, setInjectRedeploy] = useState(false);
  const [injecting, setInjecting] = useState(false);
  const [injectError, setInjectError] = useState('');

  // Test request / probe state
  const [probeNet, setProbeNet] = useState<PrivateNetwork | null>(null);
  const [probeTargetVal, setProbeTargetVal] = useState('');
  const [probeMethod, setProbeMethod] = useState<'GET' | 'POST' | 'TCP'>('GET');
  const [probePath, setProbePath] = useState('/');
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState('');
  const [probeResult, setProbeResult] = useState<NetworkProbeResult | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nets, svcs] = await Promise.all([
        apiFetch<PrivateNetwork[]>('/api/networks'),
        apiFetch<DeployedService[]>('/api/services'),
      ]);
      setNetworks(nets);
      setServices(svcs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در دریافت لیست شبکه‌های خصوصی');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const copyText = (key: string, value: string) => {
    void navigator.clipboard.writeText(value);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  const handleCreateNetwork = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError('');
    setNotice('');
    try {
      const created = await apiFetch<PrivateNetwork>('/api/networks', {
        method: 'POST',
        body: JSON.stringify({
          name: createName.trim(),
          slug: createSlug.trim() || toNetworkSlug(createName),
          description: createDescription.trim(),
          subnet: createSubnet.trim(),
          internalOnly: createInternalOnly,
        }),
      });
      setShowCreateModal(false);
      setCreateName('');
      setCreateSlug('');
      setSlugTouched(false);
      setCreateDescription('');
      setCreateSubnet('');
      setCreateInternalOnly(false);
      setNotice(`شبکه خصوصی «${created.name}» (${created.dockerName}) ایجاد شد.`);
      await loadData();
      onNetworksChanged();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'ساخت شبکه خصوصی ناموفق بود');
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteNetwork = async (id: string) => {
    setError('');
    setNotice('');
    try {
      await apiFetch(`/api/networks/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      setNotice('شبکه خصوصی با موفقیت حذف شد.');
      await loadData();
      onNetworksChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'حذف شبکه ناموفق بود');
    }
  };

  const handleAttachResource = async (networkId: string) => {
    const val = attachSelection[networkId];
    if (!val) return;
    const [resourceType, resourceId] = val.split(':');
    if (!resourceId) return;

    setAttachingNetId(networkId);
    setError('');
    setNotice('');
    try {
      await apiFetch(`/api/networks/${encodeURIComponent(networkId)}/attach`, {
        method: 'POST',
        body: JSON.stringify({ resourceType, resourceId }),
      });
      setAttachSelection((prev) => ({ ...prev, [networkId]: '' }));
      setNotice('سرویس یا پروژه به شبکه خصوصی متصل شد.');
      await loadData();
      onNetworksChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'اتصال به شبکه ناموفق بود');
    } finally {
      setAttachingNetId(null);
    }
  };

  const handleDetachResource = async (
    networkId: string,
    resourceType: 'project' | 'service',
    resourceId: string,
  ) => {
    setError('');
    setNotice('');
    try {
      await apiFetch(`/api/networks/${encodeURIComponent(networkId)}/detach`, {
        method: 'POST',
        body: JSON.stringify({ resourceType, resourceId }),
      });
      setNotice('اتصال از شبکه خصوصی قطع شد.');
      await loadData();
      onNetworksChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'قطع اتصال از شبکه ناموفق بود');
    }
  };

  const openInjectModal = (net: PrivateNetwork) => {
    setInjectModalNet(net);
    setInjectError('');
    const firstSvc = net.services[0];
    const firstProj = net.projects[0];
    const defaultSourceVal = firstSvc
      ? `service:${firstSvc.id}`
      : firstProj
        ? `project:${firstProj.id}`
        : '';
    setInjectSourceVal(defaultSourceVal);

    if (firstSvc) {
      const svcObj = services.find((s) => s.id === firstSvc.id);
      setInjectEnvKey(suggestEnvVarKey('service', svcObj));
    } else if (firstProj) {
      const projObj = projects.find((p) => p.id === firstProj.id);
      setInjectEnvKey(suggestEnvVarKey('project', projObj));
    } else {
      setInjectEnvKey('DATABASE_URL');
    }

    const firstTarget = projects.find((p) => `project:${p.id}` !== defaultSourceVal);
    setInjectTargetProjectId(firstTarget?.id ?? projects[0]?.id ?? '');
    setInjectRedeploy(false);
  };

  const handleInjectSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!injectModalNet || !injectSourceVal || !injectTargetProjectId) return;
    const [sourceType, sourceId] = injectSourceVal.split(':');
    setInjecting(true);
    setInjectError('');
    setNotice('');
    try {
      const res = await apiFetch<{
        ok: boolean;
        message: string;
        deploymentId?: string;
      }>(`/api/networks/${encodeURIComponent(injectModalNet.id)}/inject-env`, {
        method: 'POST',
        body: JSON.stringify({
          sourceType,
          sourceId,
          targetProjectId: injectTargetProjectId,
          envVarName: injectEnvKey.trim(),
          redeploy: injectRedeploy,
        }),
      });
      setInjectModalNet(null);
      setNotice(res.message);
      await loadData();
      onNetworksChanged();
      if (res.deploymentId) {
        onInspectDeployment(res.deploymentId);
      }
    } catch (err) {
      setInjectError(err instanceof Error ? err.message : 'تزریق متغیر اتصال ناموفق بود');
    } finally {
      setInjecting(false);
    }
  };

  const openProbeModal = (net: PrivateNetwork) => {
    setProbeNet(net);
    setProbeError('');
    setProbeResult(null);
    const firstSvc = net.services[0];
    const firstProj = net.projects[0];
    if (firstSvc) {
      setProbeTargetVal(`service:${firstSvc.id}`);
      setProbeMethod(firstSvc.category === 'database' ? 'TCP' : 'GET');
    } else if (firstProj) {
      setProbeTargetVal(`project:${firstProj.id}`);
      setProbeMethod('GET');
    } else {
      setProbeTargetVal('');
      setProbeMethod('GET');
    }
    setProbePath('/');
  };

  const handleProbeSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!probeNet || !probeTargetVal) return;
    const [targetType, targetId] = probeTargetVal.split(':');
    setProbing(true);
    setProbeError('');
    try {
      const res = await apiFetch<NetworkProbeResult>(
        `/api/networks/${encodeURIComponent(probeNet.id)}/test-request`,
        {
          method: 'POST',
          body: JSON.stringify({
            targetType,
            targetId,
            method: probeMethod,
            path: probePath.trim() || '/',
          }),
        },
      );
      setProbeResult(res);
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : 'خطا در ارسال درخواست تست');
    } finally {
      setProbing(false);
    }
  };

  const filteredNetworks = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return networks;
    return networks.filter(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        n.slug.toLowerCase().includes(q) ||
        n.dockerName.toLowerCase().includes(q) ||
        n.ownerUsername.toLowerCase().includes(q),
    );
  }, [networks, search]);

  return (
    <div className="space-y-6">
      {/* Toolbar Header */}
      <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-slate-100">
            شبکه‌های خصوصی ایزوله (Docker Bridge)
          </h2>
          <p className="text-xs text-slate-400 leading-relaxed max-w-3xl">
            هر کاربر می‌تواند شبکه اختصاصی بسازد، دیتابیس‌ها و سرویس‌های خود را روی آن اجرا کند، رشته اتصال را با یک کلیک به پروژه‌های دیگر تزریق کند و درخواست‌های داخلی شبکه را تست نماید.
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0 flex-wrap">
          <button
            type="button"
            onClick={loadData}
            className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#0B0F17] border border-[#1F2937] hover:border-slate-600 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            بروزرسانی
          </button>
          <button
            type="button"
            onClick={() => {
              setCreateError('');
              setShowCreateModal(true);
            }}
            className="px-4 py-2 text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            ساخت شبکه خصوصی جدید
          </button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="جستجو نام شبکه، شناسه یا مالک..."
            className="w-full bg-[#111827] border border-[#1F2937] rounded-lg pr-9 pl-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-sky-500"
          />
        </div>
        <div className="text-xs text-slate-400 tabular-nums">
          {filteredNetworks.length} شبکه خصوصی
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-xs text-red-400">
          {error}
        </div>
      )}
      {notice && (
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3 text-xs text-emerald-400">
          {notice}
        </div>
      )}

      {/* Networks List */}
      {loading ? (
        <div className="space-y-4">
          {[1, 2].map((n) => (
            <div key={n} className="h-44 bg-[#111827] border border-[#1F2937] rounded-xl animate-pulse" />
          ))}
        </div>
      ) : filteredNetworks.length === 0 ? (
        <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-10 text-center space-y-3">
          <Network className="w-8 h-8 text-slate-500 mx-auto" />
          <p className="text-sm text-slate-300">
            {networks.length === 0
              ? 'هنوز هیچ شبکه خصوصی تعریف نشده است.'
              : 'شبکه خصوصی مطابق جستجو پیدا نشد.'}
          </p>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            یک شبکه خصوصی بسازید تا دیتابیس‌ها (PostgreSQL، Redis) و پروژه‌های خود را درون یک شبکه ایزوله به هم متصل کنید.
          </p>
          {networks.length === 0 && (
            <button
              type="button"
              onClick={() => setShowCreateModal(true)}
              className="px-4 py-2 text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 rounded-lg cursor-pointer"
            >
              ساخت اولین شبکه خصوصی
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredNetworks.map((net) => {
            const attachedProjectIds = new Set(net.projects.map((p) => p.id));
            const attachedServiceIds = new Set(net.services.map((s) => s.id));
            const availableProjects = projects.filter((p) => !attachedProjectIds.has(p.id));
            const availableServices = services.filter((s) => !attachedServiceIds.has(s.id));
            const hasAnyMember = net.projects.length > 0 || net.services.length > 0;

            return (
              <section
                key={net.id}
                className="bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden"
              >
                {/* Network Card Header */}
                <div className="p-5 border-b border-[#1F2937] flex flex-col xl:flex-row xl:items-center justify-between gap-4">
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <Network className="w-4 h-4 text-sky-400 shrink-0" />
                      <h3 className="text-sm font-semibold text-slate-100">{net.name}</h3>
                      <span className="text-xs font-mono text-sky-400">{net.dockerName}</span>
                    </div>

                    <div className="text-xs text-slate-400 flex items-center gap-2 flex-wrap">
                      <span>
                        نوع: {net.internalOnly ? 'کاملاً ایزوله (بدون اینترنت خروجی)' : 'شبکه خصوصی با پل دسترسی Caddy'}
                      </span>
                      {net.subnet && (
                        <>
                          <span>·</span>
                          <span className="font-mono tabular-nums" dir="ltr">
                            {net.subnet}
                          </span>
                        </>
                      )}
                      {isAdmin && (
                        <>
                          <span>·</span>
                          <span>
                            مالک: {net.ownerDisplayName} (<span className="font-mono">{net.ownerUsername}</span>)
                          </span>
                        </>
                      )}
                      <span>·</span>
                      <span className="tabular-nums">
                        {net.services.length} سرویس · {net.projects.length} پروژه
                      </span>
                    </div>

                    {net.description && (
                      <p className="text-xs text-slate-400">{net.description}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0 flex-wrap">
                    <button
                      type="button"
                      disabled={!hasAnyMember}
                      onClick={() => openProbeModal(net)}
                      className="px-3 py-2 text-xs font-medium text-slate-200 bg-[#0B0F17] border border-[#1F2937] hover:border-sky-500/50 disabled:opacity-40 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      <Send className="w-3.5 h-3.5 text-sky-400" />
                      ارسال درخواست تست
                    </button>

                    <button
                      type="button"
                      disabled={!hasAnyMember || projects.length === 0}
                      onClick={() => openInjectModal(net)}
                      className="px-3 py-2 text-xs font-medium text-slate-200 bg-[#0B0F17] border border-[#1F2937] hover:border-emerald-500/50 disabled:opacity-40 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      <Key className="w-3.5 h-3.5 text-emerald-400" />
                      تزریق اتصال به پروژه
                    </button>

                    {confirmDeleteId === net.id ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleDeleteNetwork(net.id)}
                          className="px-3 py-2 text-xs font-medium bg-red-500 text-white rounded-lg cursor-pointer whitespace-nowrap"
                        >
                          تایید حذف شبکه
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
                        onClick={() => setConfirmDeleteId(net.id)}
                        title="حذف شبکه خصوصی"
                        className="p-2 text-red-400 bg-[#0B0F17] border border-[#1F2937] hover:border-red-500/40 rounded-lg cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Attached Members Table/List */}
                <div className="divide-y divide-[#1F2937]">
                  {!hasAnyMember ? (
                    <div className="p-5 text-xs text-slate-400 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <span>
                        هنوز هیچ سرویس یا پروژه‌ای به این شبکه خصوصی متصل نشده است.
                      </span>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => onNavigate('templates')}
                          className="text-sky-400 hover:text-sky-300 cursor-pointer whitespace-nowrap"
                        >
                          نصب دیتابیس روی این شبکه ←
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {net.services.map((svc) => (
                        <div
                          key={`svc-${svc.id}`}
                          className="px-5 py-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3 hover:bg-slate-800/20"
                        >
                          <div className="space-y-1 min-w-0">
                            <div className="flex items-center gap-2.5 flex-wrap">
                              <Database className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                              <span className="text-xs font-semibold text-slate-100">{svc.name}</span>
                              <span className="text-[11px] text-slate-400">
                                سرویس آماده ({svc.category === 'database' ? 'دیتابیس/کش' : 'اپ'})
                              </span>
                              <span
                                className={`text-[11px] font-medium ${
                                  svc.status === 'running' ? 'text-emerald-400' : 'text-slate-400'
                                }`}
                              >
                                {svc.status === 'running' ? 'فعال' : svc.status}
                              </span>
                            </div>

                            <div className="text-[11px] text-slate-400 font-mono tabular-nums flex items-center gap-2 flex-wrap" dir="ltr">
                              <span className="text-sky-400">{svc.internalHost}</span>
                              <span>·</span>
                              <span>alias: {svc.aliasHost}</span>
                              {svc.ipv4Address && (
                                <>
                                  <span>·</span>
                                  <span>IP: {svc.ipv4Address}</span>
                                </>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => copyText(`host-${net.id}-${svc.id}`, svc.internalHost)}
                              className="px-2.5 py-1.5 text-[11px] text-slate-300 bg-[#0B0F17] border border-[#1F2937] hover:border-slate-600 rounded-lg flex items-center gap-1 cursor-pointer whitespace-nowrap"
                            >
                              {copiedKey === `host-${net.id}-${svc.id}` ? (
                                <Check className="w-3 h-3 text-emerald-400" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                              <span>کپی آدرس داخلی</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDetachResource(net.id, 'service', svc.id)}
                              title="قطع اتصال از شبکه"
                              className="p-1.5 text-slate-400 hover:text-red-400 bg-[#0B0F17] border border-[#1F2937] rounded-lg cursor-pointer"
                            >
                              <Unlink className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}

                      {net.projects.map((proj) => (
                        <div
                          key={`prj-${proj.id}`}
                          className="px-5 py-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3 hover:bg-slate-800/20"
                        >
                          <div className="space-y-1 min-w-0">
                            <div className="flex items-center gap-2.5 flex-wrap">
                              <GitBranch className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                              <span className="text-xs font-semibold text-slate-100">{proj.name}</span>
                              <span className="text-[11px] text-slate-400">پروژه CI/CD</span>
                              <span
                                className={`text-[11px] font-medium ${
                                  proj.status === 'running' ? 'text-emerald-400' : 'text-slate-400'
                                }`}
                              >
                                {proj.status === 'running' ? 'در حال اجرا' : proj.status}
                              </span>
                            </div>

                            <div className="text-[11px] text-slate-400 font-mono tabular-nums flex items-center gap-2 flex-wrap" dir="ltr">
                              <span className="text-sky-400">http://{proj.internalHost}</span>
                              <span>·</span>
                              <span>alias: {proj.aliasHost}</span>
                              {proj.ipv4Address && (
                                <>
                                  <span>·</span>
                                  <span>IP: {proj.ipv4Address}</span>
                                </>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() =>
                                copyText(`host-${net.id}-${proj.id}`, `http://${proj.internalHost}`)
                              }
                              className="px-2.5 py-1.5 text-[11px] text-slate-300 bg-[#0B0F17] border border-[#1F2937] hover:border-slate-600 rounded-lg flex items-center gap-1 cursor-pointer whitespace-nowrap"
                            >
                              {copiedKey === `host-${net.id}-${proj.id}` ? (
                                <Check className="w-3 h-3 text-emerald-400" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                              <span>کپی نشانی داخلی</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDetachResource(net.id, 'project', proj.id)}
                              title="قطع اتصال از شبکه"
                              className="p-1.5 text-slate-400 hover:text-red-400 bg-[#0B0F17] border border-[#1F2937] rounded-lg cursor-pointer"
                            >
                              <Unlink className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>

                {/* Attach Existing Service/Project Bar */}
                {(availableProjects.length > 0 || availableServices.length > 0) && (
                  <div className="px-5 py-3 bg-[#0B0F17]/60 border-t border-[#1F2937] flex flex-col sm:flex-row sm:items-center gap-2.5">
                    <span className="text-[11px] text-slate-400 shrink-0">
                      اتصال منبع موجود به شبکه:
                    </span>
                    <select
                      value={attachSelection[net.id] ?? ''}
                      onChange={(e) =>
                        setAttachSelection((prev) => ({ ...prev, [net.id]: e.target.value }))
                      }
                      className="flex-1 max-w-md bg-[#111827] border border-[#1F2937] rounded-lg px-3 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-sky-500"
                    >
                      <option value="">انتخاب سرویس یا پروژه برای اتصال...</option>
                      {availableServices.length > 0 && (
                        <optgroup label="سرویس‌های آماده و دیتابیس‌ها">
                          {availableServices.map((s) => (
                            <option key={s.id} value={`service:${s.id}`}>
                              {s.name} ({s.containerName}:{s.containerPort})
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {availableProjects.length > 0 && (
                        <optgroup label="پروژه‌های CI/CD">
                          {availableProjects.map((p) => (
                            <option key={p.id} value={`project:${p.id}`}>
                              {p.name} (sokkan-{p.slug}:{p.containerPort})
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    <button
                      type="button"
                      disabled={!attachSelection[net.id] || attachingNetId === net.id}
                      onClick={() => handleAttachResource(net.id)}
                      className="px-3.5 py-1.5 text-xs font-medium bg-[#1F2937] hover:bg-slate-700 disabled:opacity-40 text-slate-100 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap self-start sm:self-auto"
                    >
                      <Link2 className="w-3.5 h-3.5" />
                      {attachingNetId === net.id ? 'در حال اتصال...' : 'اتصال به شبکه'}
                    </button>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {/* Create Network Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-[#1F2937] flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-100">ایجاد شبکه خصوصی جدید</h2>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="text-slate-400 hover:text-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateNetwork} className="p-6 space-y-4 text-xs">
              {createError && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3.5 py-2.5 text-red-400">
                  {createError}
                </div>
              )}

              <div>
                <label className="block text-slate-300 mb-1">نام نمایشی شبکه</label>
                <input
                  type="text"
                  required
                  value={createName}
                  onChange={(e) => {
                    const val = e.target.value;
                    setCreateName(val);
                    if (!slugTouched) {
                      setCreateSlug(toNetworkSlug(val));
                    }
                  }}
                  placeholder="مثلاً شبکه بک‌اند فروشگاه"
                  className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-sky-500"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-300 mb-1">شناسه انگلیسی (Slug)</label>
                  <input
                    type="text"
                    required
                    value={createSlug}
                    onChange={(e) => {
                      setCreateSlug(e.target.value);
                      setSlugTouched(e.target.value.trim().length > 0);
                    }}
                    dir="ltr"
                    placeholder="shop-private"
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                  />
                  <p className="mt-1 text-[11px] text-slate-500 font-mono" dir="ltr">
                    docker: sokkan-net-{createSlug || 'slug'}
                  </p>
                </div>

                <div>
                  <label className="block text-slate-300 mb-1">رنج Subnet (اختیاری)</label>
                  <input
                    type="text"
                    value={createSubnet}
                    onChange={(e) => setCreateSubnet(e.target.value)}
                    dir="ltr"
                    placeholder="172.28.10.0/24"
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-300 mb-1">توضیحات (اختیاری)</label>
                <input
                  type="text"
                  value={createDescription}
                  onChange={(e) => setCreateDescription(e.target.value)}
                  placeholder="ارتباط بین سرویس‌های دیتابیس و API این تیم"
                  className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-sky-500"
                />
              </div>

              <label className="flex items-start gap-2.5 text-slate-300 cursor-pointer bg-[#0B0F17] border border-[#1F2937] rounded-lg p-3">
                <input
                  type="checkbox"
                  checked={createInternalOnly}
                  onChange={(e) => setCreateInternalOnly(e.target.checked)}
                  className="accent-sky-500 mt-0.5"
                />
                <div className="space-y-0.5">
                  <div className="font-medium text-slate-200 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-sky-400" />
                    <span>حالت کاملاً ایزوله (Internal Only)</span>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    کانتینرهای این شبکه فقط با هم ارتباط دارند و دسترسی مستقیم به اینترنت خروجی یا پل Caddy نخواهند داشت (مناسب دیتابیس‌های محرمانه).
                  </p>
                </div>
              </label>

              <div className="pt-3 border-t border-[#1F2937] flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-slate-300 hover:text-slate-100 cursor-pointer"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-5 py-2 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-semibold rounded-lg cursor-pointer"
                >
                  {creating ? 'در حال ساخت شبکه...' : 'ایجاد شبکه خصوصی'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Inject Connection Env Modal */}
      {injectModalNet && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-[#1F2937] flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-slate-100">
                  تزریق رشته اتصال به پروژه دیگر
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  در شبکه خصوصی «{injectModalNet.name}»
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInjectModalNet(null)}
                className="text-slate-400 hover:text-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleInjectSubmit} className="p-6 space-y-4 text-xs">
              {injectError && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3.5 py-2.5 text-red-400">
                  {injectError}
                </div>
              )}

              <div>
                <label className="block text-slate-300 mb-1">۱. سرویس یا پروژه مبدا (داخل این شبکه)</label>
                <select
                  value={injectSourceVal}
                  onChange={(e) => {
                    const val = e.target.value;
                    setInjectSourceVal(val);
                    const [t, sid] = val.split(':');
                    if (t === 'service') {
                      setInjectEnvKey(
                        suggestEnvVarKey('service', services.find((s) => s.id === sid)),
                      );
                    } else {
                      setInjectEnvKey(
                        suggestEnvVarKey('project', projects.find((p) => p.id === sid)),
                      );
                    }
                  }}
                  className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-sky-500"
                >
                  {injectModalNet.services.map((s) => (
                    <option key={`s-${s.id}`} value={`service:${s.id}`}>
                      سرویس: {s.name} ({s.internalHost})
                    </option>
                  ))}
                  {injectModalNet.projects.map((p) => (
                    <option key={`p-${p.id}`} value={`project:${p.id}`}>
                      پروژه: {p.name} ({p.internalHost})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-300 mb-1">۲. پروژه مقصد (دریافت‌کننده متغیر)</label>
                <select
                  value={injectTargetProjectId}
                  onChange={(e) => setInjectTargetProjectId(e.target.value)}
                  className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-sky-500"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} (sokkan-{p.slug})
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-slate-400">
                  اگر پروژه مقصد هنوز عضو این شبکه نباشد، به صورت خودکار به شبکه متصل می‌شود.
                </p>
              </div>

              <div>
                <label className="block text-slate-300 mb-1">۳. نام متغیر محیطی (.env)</label>
                <input
                  type="text"
                  required
                  value={injectEnvKey}
                  onChange={(e) => setInjectEnvKey(e.target.value)}
                  dir="ltr"
                  placeholder="DATABASE_URL"
                  className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                />
              </div>

              <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={injectRedeploy}
                  onChange={(e) => setInjectRedeploy(e.target.checked)}
                  className="accent-sky-500"
                />
                دیپلوی مجدد پروژه مقصد بلافاصله بعد از تزریق متغیر
              </label>

              <div className="pt-3 border-t border-[#1F2937] flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setInjectModalNet(null)}
                  className="px-4 py-2 text-slate-300 hover:text-slate-100 cursor-pointer"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  disabled={injecting || !injectTargetProjectId}
                  className="px-5 py-2 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-semibold rounded-lg cursor-pointer"
                >
                  {injecting ? 'در حال تزریق...' : 'تزریق متغیر اتصال'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Test Network Request Modal */}
      {probeNet && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="w-full max-w-xl bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-[#1F2937] flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-slate-100">
                  تست ارتباط و ارسال درخواست روی شبکه خصوصی
                </h2>
                <p className="text-xs text-slate-400 mt-0.5 font-mono" dir="ltr">
                  {probeNet.dockerName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setProbeNet(null)}
                className="text-slate-400 hover:text-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleProbeSubmit} className="p-6 overflow-y-auto space-y-4 text-xs">
              {probeError && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3.5 py-2.5 text-red-400">
                  {probeError}
                </div>
              )}

              <div>
                <label className="block text-slate-300 mb-1">کانتینر مقصد در شبکه</label>
                <select
                  value={probeTargetVal}
                  onChange={(e) => {
                    const val = e.target.value;
                    setProbeTargetVal(val);
                    const [t, tid] = val.split(':');
                    if (t === 'service') {
                      const s = probeNet.services.find((item) => item.id === tid);
                      if (s?.category === 'database') setProbeMethod('TCP');
                    }
                  }}
                  className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-sky-500"
                >
                  {probeNet.services.map((s) => (
                    <option key={`ps-${s.id}`} value={`service:${s.id}`}>
                      {s.name} ({s.internalHost})
                    </option>
                  ))}
                  {probeNet.projects.map((p) => (
                    <option key={`pp-${p.id}`} value={`project:${p.id}`}>
                      {p.name} ({p.internalHost})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-300 mb-1">نوع درخواست</label>
                  <select
                    value={probeMethod}
                    onChange={(e) => setProbeMethod(e.target.value as 'GET' | 'POST' | 'TCP')}
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono"
                  >
                    <option value="GET">HTTP GET</option>
                    <option value="POST">HTTP POST</option>
                    <option value="TCP">TCP Port Check</option>
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-slate-300 mb-1">مسیر (برای HTTP)</label>
                  <input
                    type="text"
                    disabled={probeMethod === 'TCP'}
                    value={probePath}
                    onChange={(e) => setProbePath(e.target.value)}
                    dir="ltr"
                    placeholder="/health"
                    className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono disabled:opacity-40 focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

              {probeResult && (
                <div className="bg-[#0B0F17] border border-[#1F2937] rounded-lg p-4 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`font-semibold ${
                        probeResult.reachable ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {probeResult.reachable ? 'اتصال برقرار شد' : 'اتصال برقرار نشد'}
                    </span>
                    <span className="font-mono text-slate-400 tabular-nums" dir="ltr">
                      {probeResult.statusCode ? `HTTP ${probeResult.statusCode} · ` : ''}
                      {probeResult.latencyMs}ms
                      {probeResult.resolvedIp ? ` · ${probeResult.resolvedIp}` : ''}
                    </span>
                  </div>
                  <p className="text-slate-300 leading-relaxed">{probeResult.message}</p>
                  {probeResult.responsePreview && (
                    <pre
                      dir="ltr"
                      className="p-3 bg-[#111827] border border-[#1F2937] rounded-lg font-mono text-[11px] text-slate-300 overflow-x-auto max-h-48 whitespace-pre-wrap"
                    >
                      {probeResult.responsePreview}
                    </pre>
                  )}
                </div>
              )}

              <div className="pt-3 border-t border-[#1F2937] flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setProbeNet(null)}
                  className="px-4 py-2 text-slate-300 hover:text-slate-100 cursor-pointer"
                >
                  بستن
                </button>
                <button
                  type="submit"
                  disabled={probing || !probeTargetVal}
                  className="px-5 py-2 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-semibold rounded-lg flex items-center gap-1.5 cursor-pointer"
                >
                  <Send className="w-3.5 h-3.5" />
                  {probing ? 'در حال ارسال...' : 'اجرای تست اتصال'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
