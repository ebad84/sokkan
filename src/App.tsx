import {
  Activity,
  Box,
  GitBranch,
  Globe,
  LogOut,
  Menu,
  Plus,
  ServerCog,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, setAuthToken } from './api';
import { AuthGate } from './components/AuthGate';
import { CaddyPage } from './components/CaddyPage';
import { ContainersPage } from './components/ContainersPage';
import { OverviewPage } from './components/OverviewPage';
import { DeploymentDrawer, ProjectsPage } from './components/ProjectsPage';
import { ProvisioningPage } from './components/ProvisioningPage';
import type {
  AuthStatus,
  BeszelConfig,
  Deployment,
  NavTab,
  Project,
  SystemStatus,
} from './types';

const NAV_ITEMS: Array<{ id: NavTab; label: string; icon: typeof Activity }> = [
  { id: 'overview', label: 'نمای کلی سرور', icon: Activity },
  { id: 'projects', label: 'پروژه‌ها و CI/CD', icon: GitBranch },
  { id: 'containers', label: 'کانتینرها و داکر', icon: Box },
  { id: 'caddy', label: 'مدیریت Caddy', icon: Globe },
  { id: 'provisioning', label: 'راه‌اندازی و بکاپ', icon: ServerCog },
];

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [beszelConfig, setBeszelConfig] = useState<BeszelConfig | null>(null);
  const [loadingData, setLoadingData] = useState(false);

  const [addProjectTrigger, setAddProjectTrigger] = useState(0);
  const [inspectDeploymentId, setInspectDeploymentId] = useState<string | null>(null);

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
      const [sys, projs, deps, beszel] = await Promise.all([
        apiFetch<SystemStatus>('/api/system/status'),
        apiFetch<Project[]>('/api/projects'),
        apiFetch<Deployment[]>('/api/deployments'),
        apiFetch<{ config: BeszelConfig }>('/api/integrations/beszel'),
      ]);
      setSystemStatus(sys);
      setProjects(projs);
      setDeployments(deps);
      setBeszelConfig(beszel.config);
    } catch (err) {
      if (err instanceof Error && err.message.includes('احراز هویت')) {
        setAuthStatus((prev) => (prev ? { ...prev, authenticated: false } : null));
      }
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (authStatus?.authenticated) {
      void loadDashboardData();
    }
  }, [authStatus?.authenticated, loadDashboardData]);

  const handleLogout = () => {
    setAuthToken(null);
    setAuthStatus((prev) => (prev ? { ...prev, authenticated: false } : null));
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
        onAuthenticated={() => {
          setAuthStatus((prev) =>
            prev ? { ...prev, authenticated: true, needsSetup: false } : { authenticated: true, needsSetup: false, envPasscodeActive: false },
          );
        }}
      />
    );
  }

  const activeNavMeta = NAV_ITEMS.find((n) => n.id === activeTab) ?? NAV_ITEMS[0];

  const handlePrimaryAction = () => {
    setActiveTab('projects');
    setAddProjectTrigger((n) => n + 1);
  };

  return (
    <div className="min-h-screen bg-[#0B0F17] text-[#F8FAFC] flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex w-[260px] shrink-0 bg-[#111827] border-l border-[#1F2937] flex-col justify-between">
        <div>
          <div className="h-16 px-6 border-b border-[#1F2937] flex items-center gap-3">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              className="text-sky-400 shrink-0"
            >
              <rect x="3" y="3" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.8" />
              <rect x="13" y="3" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.8" />
              <rect x="3" y="13" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.8" />
              <path d="M17 13v8M13 17h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <span className="text-base font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0">
              سکان‌یار
            </span>
          </div>

          <nav className="p-3 space-y-1">
            {NAV_ITEMS.map((item) => {
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
          <div className="bg-[#0B0F17] border border-[#1F2937] rounded-lg p-3 space-y-1">
            <div className="text-slate-400">محیط اجرا</div>
            <div className="font-medium text-slate-200">
              {systemStatus?.executionMode === 'vps'
                ? 'VPS عملیاتی (Docker متصل)'
                : 'پیش‌نمایش وب (بدون داکر)'}
            </div>
          </div>

          <button
            type="button"
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-[#1F2937] text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors cursor-pointer whitespace-nowrap"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>خروج از نشست</span>
          </button>
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
                <span className="text-base font-bold text-slate-100">سکان‌یار</span>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  className="text-slate-400 hover:text-slate-100 p-1"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <nav className="p-3 space-y-1">
                {NAV_ITEMS.map((item) => {
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
            <div className="p-4 border-t border-[#1F2937]">
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
              onRefresh={loadDashboardData}
              onNavigate={setActiveTab}
              onInspectDeployment={setInspectDeploymentId}
              onBeszelSaved={loadDashboardData}
            />
          )}

          {activeTab === 'projects' && (
            <ProjectsPage
              projects={projects}
              deployments={deployments}
              openAddModalTrigger={addProjectTrigger}
              onRefresh={loadDashboardData}
              onInspectDeployment={setInspectDeploymentId}
            />
          )}

          {activeTab === 'containers' && <ContainersPage onNavigate={setActiveTab} />}

          {activeTab === 'caddy' && <CaddyPage />}

          {activeTab === 'provisioning' && (
            <ProvisioningPage onBackupRestored={loadDashboardData} />
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
    </div>
  );
}
