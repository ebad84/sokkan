import {
  Activity,
  Box,
  GitBranch,
  Globe,
  KeyRound,
  Layers,
  LogOut,
  Menu,
  Network,
  Plus,
  ServerCog,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { apiFetch, setAuthToken } from './api';
import { AuthGate } from './components/AuthGate';
import { CaddyPage } from './components/CaddyPage';
import { ContainersPage } from './components/ContainersPage';
import { NetworksPage } from './components/NetworksPage';
import { OverviewPage } from './components/OverviewPage';
import { DeploymentDrawer, ProjectsPage } from './components/ProjectsPage';
import { ProvisioningPage } from './components/ProvisioningPage';
import { SokkanLogo } from './components/SokkanLogo';
import { TemplatesPage } from './components/TemplatesPage';
import { UsersPage } from './components/UsersPage';
import type {
  AuthStatus,
  BeszelConfig,
  Deployment,
  NavTab,
  PrivateNetwork,
  Project,
  SystemStatus,
} from './types';

const NAV_ITEMS: Array<{
  id: NavTab;
  label: string;
  icon: typeof Activity;
  adminOnly?: boolean;
}> = [
  { id: 'overview', label: 'نمای کلی سرور', icon: Activity },
  { id: 'networks', label: 'شبکه‌های خصوصی', icon: Network },
  { id: 'projects', label: 'پروژه‌ها و CI/CD', icon: GitBranch },
  { id: 'templates', label: 'سرویس‌های آماده', icon: Layers },
  { id: 'containers', label: 'کانتینرها و داکر', icon: Box },
  { id: 'caddy', label: 'مدیریت Caddy', icon: Globe, adminOnly: true },
  { id: 'provisioning', label: 'راه‌اندازی و بکاپ', icon: ServerCog, adminOnly: true },
  { id: 'users', label: 'کاربران و دسترسی‌ها', icon: Users, adminOnly: true },
];

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [networks, setNetworks] = useState<PrivateNetwork[]>([]);
  const [beszelConfig, setBeszelConfig] = useState<BeszelConfig | null>(null);
  const [loadingData, setLoadingData] = useState(false);

  const [addProjectTrigger, setAddProjectTrigger] = useState(0);
  const [inspectDeploymentId, setInspectDeploymentId] = useState<string | null>(null);

  // Self-service password modal
  const [showPwdModal, setShowPwdModal] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pwdSaving, setPwdSaving] = useState(false);
  const [pwdError, setPwdError] = useState('');
  const [pwdSuccess, setPwdSuccess] = useState('');

  const currentUser = authStatus?.user;
  const isAdmin = currentUser?.role === 'admin';

  const visibleNavItems = useMemo(
    () => NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin),
    [isAdmin],
  );

  const checkAuth = useCallback(async () => {
    try {
      const status = await apiFetch<AuthStatus>('/api/auth/status');
      setAuthStatus(status);
    } catch {
      setAuthStatus({ authenticated: false, needsSetup: false, envPasscodeActive: false });
    }
  }, []);

  const loadDashboardData = useCallback(async () => {
    setLoadingData(true);
    try {
      const beszelPromise = isAdmin
        ? apiFetch<{ config: BeszelConfig }>('/api/integrations/beszel').catch(() => ({
            config: null,
          }))
        : Promise.resolve({ config: null as BeszelConfig | null });

      const [sys, projs, deps, nets, beszel] = await Promise.all([
        apiFetch<SystemStatus>('/api/system/status'),
        apiFetch<Project[]>('/api/projects'),
        apiFetch<Deployment[]>('/api/deployments'),
        apiFetch<PrivateNetwork[]>('/api/networks'),
        beszelPromise,
      ]);
      setSystemStatus(sys);
      setProjects(projs);
      setDeployments(deps);
      setNetworks(nets);
      setBeszelConfig(beszel.config);
    } catch (err) {
      if (err instanceof Error && err.message.includes('احراز هویت')) {
        setAuthStatus((prev) => (prev ? { ...prev, authenticated: false, user: undefined } : null));
      }
    } finally {
      setLoadingData(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (authStatus?.authenticated) {
      void loadDashboardData();
    }
  }, [authStatus?.authenticated, loadDashboardData]);

  useEffect(() => {
    if (authStatus?.authenticated && !isAdmin) {
      if (activeTab === 'caddy' || activeTab === 'provisioning' || activeTab === 'users') {
        setActiveTab('overview');
      }
    }
  }, [authStatus?.authenticated, isAdmin, activeTab]);

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Clear local state regardless
    }
    setAuthToken(null);
    setActiveTab('overview');
    setAuthStatus((prev) => (prev ? { ...prev, authenticated: false, user: undefined } : null));
  };

  const handleChangeOwnPassword = async (e: FormEvent) => {
    e.preventDefault();
    setPwdSaving(true);
    setPwdError('');
    setPwdSuccess('');
    try {
      await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setPwdSuccess('رمز عبور شما با موفقیت تغییر یافت.');
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      setPwdError(err instanceof Error ? err.message : 'تغییر رمز عبور ناموفق بود');
    } finally {
      setPwdSaving(false);
    }
  };

  if (!authStatus) {
    return (
      <div className="min-h-screen bg-[#0B0F17] flex items-center justify-center text-xs text-slate-400">
        در حال بررسی وضعیت سرور...
      </div>
    );
  }

  if (!authStatus.authenticated) {
    return (
      <AuthGate
        authStatus={authStatus}
        onAuthenticated={(user) => {
          setAuthStatus((prev) =>
            prev
              ? { ...prev, authenticated: true, needsSetup: false, user }
              : { authenticated: true, needsSetup: false, envPasscodeActive: false, user },
          );
        }}
      />
    );
  }

  const activeNavMeta = visibleNavItems.find((n) => n.id === activeTab) ?? visibleNavItems[0];

  const handlePrimaryAction = () => {
    setActiveTab('projects');
    setAddProjectTrigger((n) => n + 1);
  };

  const canChangeOwnPassword = !(authStatus.envPasscodeActive && currentUser?.id === 'usr_admin');

  return (
    <div className="min-h-screen bg-[#0B0F17] text-[#F8FAFC] flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex w-[260px] shrink-0 bg-[#111827] border-l border-[#1F2937] flex-col justify-between">
        <div>
          <div className="h-16 px-6 border-b border-[#1F2937] flex items-center justify-between gap-2">
            <div className="flex items-center gap-3 min-w-0">
              <SokkanLogo size={32} />
              <span className="text-base font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0">
                سکان
              </span>
            </div>
            {systemStatus?.appVersion?.version && (
              <span
                dir="ltr"
                className="text-[11px] font-mono tabular-nums text-sky-400 bg-sky-500/10 border border-sky-500/20 px-2 py-0.5 rounded-md shrink-0"
              >
                v{systemStatus.appVersion.version}
              </span>
            )}
          </div>

          <nav className="p-3 space-y-1">
            {visibleNavItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer whitespace-nowrap ${
                    isActive
                      ? 'bg-sky-500/10 text-sky-400'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/40'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="p-4 border-t border-[#1F2937] space-y-3 text-xs">
          {currentUser && (
            <div className="bg-[#0B0F17] border border-[#1F2937] rounded-lg p-3 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-100 truncate">
                  {currentUser.displayName}
                </span>
                <span className="text-[11px] text-sky-400 shrink-0">
                  {currentUser.role === 'admin' ? 'مدیر کل' : 'کاربر'}
                </span>
              </div>
              <div className="font-mono text-[11px] text-slate-400 truncate" dir="ltr">
                @{currentUser.username}
              </div>
            </div>
          )}

          <div className="bg-[#0B0F17] border border-[#1F2937] rounded-lg p-3 space-y-1">
            <div className="text-slate-400">محیط اجرا</div>
            <div className="font-medium text-slate-200">
              {systemStatus?.executionMode === 'vps'
                ? 'VPS عملیاتی (Docker متصل)'
                : 'پیش‌نمایش وب (بدون داکر)'}
            </div>
            {authStatus.caddyUser && (
              <div className="text-[11px] text-emerald-400 pt-1">
                Caddy Basic Auth ({authStatus.caddyUser})
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {canChangeOwnPassword && (
              <button
                type="button"
                onClick={() => {
                  setPwdError('');
                  setPwdSuccess('');
                  setShowPwdModal(true);
                }}
                title="تغییر رمز عبور"
                className="p-2 rounded-lg border border-[#1F2937] text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors cursor-pointer shrink-0"
              >
                <KeyRound className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={handleLogout}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-[#1F2937] text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors cursor-pointer whitespace-nowrap"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>خروج از نشست</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Drawer Sidebar */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative z-50 w-64 bg-[#111827] border-l border-[#1F2937] flex flex-col justify-between">
            <div>
              <div className="h-16 px-5 border-b border-[#1F2937] flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <SokkanLogo size={28} />
                  <span className="text-base font-bold text-slate-100">سکان</span>
                  {systemStatus?.appVersion?.version && (
                    <span
                      dir="ltr"
                      className="text-[11px] font-mono tabular-nums text-sky-400 bg-sky-500/10 border border-sky-500/20 px-1.5 py-0.5 rounded-md"
                    >
                      v{systemStatus.appVersion.version}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  className="text-slate-400 hover:text-slate-100 p-1"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <nav className="p-3 space-y-1">
                {visibleNavItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setActiveTab(item.id);
                        setMobileMenuOpen(false);
                      }}
                      className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium cursor-pointer whitespace-nowrap ${
                        isActive ? 'bg-sky-500/10 text-sky-400' : 'text-slate-300'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </nav>
            </div>
            <div className="p-4 border-t border-[#1F2937] space-y-2">
              {currentUser && (
                <div className="text-xs text-slate-300 px-1">
                  {currentUser.displayName} (@{currentUser.username})
                </div>
              )}
              <button
                type="button"
                onClick={handleLogout}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-[#1F2937] text-xs text-slate-300 cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>خروج از نشست</span>
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract */}
        <header className="h-16 px-6 bg-[#111827]/70 border-b border-[#1F2937] flex items-center justify-between gap-8 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 -mr-2 text-slate-300 hover:text-slate-100 cursor-pointer"
              aria-label="باز کردن منو"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm truncate">
              <span className="text-slate-400 hidden sm:inline">کنسول سرور</span>
              <span className="text-slate-600 hidden sm:inline">/</span>
              <h1 className="font-semibold text-slate-100 truncate">{activeNavMeta.label}</h1>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={handlePrimaryAction}
              className="px-4 py-2 text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4" />
              اتصال مخزن جدید
            </button>
          </div>
        </header>

        {/* Main Viewport */}
        <main className="flex-1 p-6 max-w-[1440px] w-full mx-auto">
          {activeTab === 'overview' && (
            <OverviewPage
              status={systemStatus}
              loading={loadingData}
              projects={projects}
              deployments={deployments}
              beszelConfig={beszelConfig}
              isAdmin={isAdmin}
              networksCount={systemStatus?.counts?.networks ?? networks.length}
              onRefresh={loadDashboardData}
              onNavigate={setActiveTab}
              onInspectDeployment={setInspectDeploymentId}
              onBeszelSaved={loadDashboardData}
            />
          )}

          {activeTab === 'networks' && (
            <NetworksPage
              projects={projects}
              isAdmin={isAdmin}
              onNetworksChanged={loadDashboardData}
              onNavigate={setActiveTab}
              onInspectDeployment={setInspectDeploymentId}
            />
          )}

          {activeTab === 'projects' && (
            <ProjectsPage
              projects={projects}
              deployments={deployments}
              networks={networks}
              isAdmin={isAdmin}
              openAddModalTrigger={addProjectTrigger}
              onRefresh={loadDashboardData}
              onInspectDeployment={setInspectDeploymentId}
            />
          )}

          {activeTab === 'templates' && (
            <TemplatesPage networks={networks} onServiceChanged={loadDashboardData} />
          )}

          {activeTab === 'containers' && (
            <ContainersPage isAdmin={isAdmin} onNavigate={setActiveTab} />
          )}

          {activeTab === 'caddy' && isAdmin && <CaddyPage />}

          {activeTab === 'provisioning' && isAdmin && (
            <ProvisioningPage onBackupRestored={loadDashboardData} />
          )}

          {activeTab === 'users' && isAdmin && currentUser && (
            <UsersPage currentUserId={currentUser.id} />
          )}
        </main>
      </div>

      {/* Global Deployment Stream Drawer */}
      <DeploymentDrawer
        deploymentId={inspectDeploymentId}
        projects={projects}
        onClose={() => setInspectDeploymentId(null)}
        onDeploymentFinished={loadDashboardData}
      />

      {/* Self-service Change Password Modal */}
      {showPwdModal && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-[#1F2937] flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-100">تغییر رمز عبور حساب</h2>
              <button
                type="button"
                onClick={() => setShowPwdModal(false)}
                className="text-slate-400 hover:text-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleChangeOwnPassword} className="p-6 space-y-4 text-xs">
              {pwdError && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3.5 py-2.5 text-red-400">
                  {pwdError}
                </div>
              )}
              {pwdSuccess && (
                <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3.5 py-2.5 text-emerald-400">
                  {pwdSuccess}
                </div>
              )}

              <div>
                <label className="block text-slate-300 mb-1">رمز عبور فعلی</label>
                <input
                  type="password"
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  dir="ltr"
                  className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 mb-1">رمز عبور جدید (حداقل ۸ کاراکتر)</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  dir="ltr"
                  className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                />
              </div>

              <div className="pt-3 border-t border-[#1F2937] flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowPwdModal(false)}
                  className="px-4 py-2 text-slate-300 hover:text-slate-100 cursor-pointer"
                >
                  بستن
                </button>
                <button
                  type="submit"
                  disabled={pwdSaving}
                  className="px-5 py-2 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-semibold rounded-lg cursor-pointer"
                >
                  {pwdSaving ? 'در حال ذخیره...' : 'ثبت رمز عبور جدید'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
