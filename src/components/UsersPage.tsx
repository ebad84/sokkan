import { Key, Plus, RefreshCw, Shield, Trash2, UserCheck, UserX, Users, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiFetch } from '../api';
import type { PanelUser } from '../types';

interface UsersPageProps {
  currentUserId: string;
}

export function UsersPage({ currentUserId }: UsersPageProps) {
  const [users, setUsers] = useState<PanelUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Add user modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Reset password modal
  const [resetTarget, setResetTarget] = useState<PanelUser | null>(null);
  const [resetPasswordVal, setResetPasswordVal] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState('');

  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = await apiFetch<PanelUser[]>('/api/users');
      setUsers(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در دریافت لیست کاربران');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const handleCreateUser = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError('');
    setNotice('');
    try {
      const created = await apiFetch<PanelUser>('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          username: username.trim(),
          displayName: displayName.trim() || username.trim(),
          password,
          role,
        }),
      });
      setShowAddModal(false);
      setUsername('');
      setDisplayName('');
      setPassword('');
      setRole('member');
      setNotice(`کاربر «${created.displayName}» (${created.username}) ساخته شد.`);
      await loadUsers();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'خطا در ایجاد کاربر');
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (u: PanelUser) => {
    setBusyId(u.id);
    setError('');
    setNotice('');
    try {
      await apiFetch(`/api/users/${encodeURIComponent(u.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !u.isActive }),
      });
      setNotice(
        u.isActive ? `حساب «${u.username}» غیرفعال شد.` : `حساب «${u.username}» فعال شد.`,
      );
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تغییر وضعیت کاربر ناموفق بود');
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleRole = async (u: PanelUser) => {
    setBusyId(u.id);
    setError('');
    setNotice('');
    const nextRole = u.role === 'admin' ? 'member' : 'admin';
    try {
      await apiFetch(`/api/users/${encodeURIComponent(u.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: nextRole }),
      });
      setNotice(
        `نقش «${u.username}» به ${nextRole === 'admin' ? 'مدیر کل' : 'کاربر عادی'} تغییر یافت.`,
      );
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تغییر نقش کاربر ناموفق بود');
    } finally {
      setBusyId(null);
    }
  };

  const handleResetPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (!resetTarget) return;
    setResetting(true);
    setResetError('');
    setNotice('');
    try {
      await apiFetch(`/api/users/${encodeURIComponent(resetTarget.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ password: resetPasswordVal }),
      });
      setNotice(`رمز عبور جدید برای «${resetTarget.username}» ثبت شد.`);
      setResetTarget(null);
      setResetPasswordVal('');
    } catch (err) {
      setResetError(err instanceof Error ? err.message : 'تغییر رمز عبور ناموفق بود');
    } finally {
      setResetting(false);
    }
  };

  const handleDeleteUser = async (id: string) => {
    setBusyId(id);
    setError('');
    setNotice('');
    try {
      await apiFetch(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      setNotice('کاربر حذف شد.');
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'حذف کاربر ناموفق بود');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-slate-100">
            مدیریت کاربران و سطح دسترسی
          </h2>
          <p className="text-xs text-slate-400 leading-relaxed max-w-3xl">
            مدیر می‌تواند برای توسعه‌دهندگان و تیم‌ها حساب جداگانه بسازد. هر کاربر فضای اختصاصی برای ساخت شبکه‌های خصوصی، دیتابیس‌ها و پروژه‌های خودش دارد و به منابع دیگران دسترسی ندارد.
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={loadUsers}
            className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#0B0F17] border border-[#1F2937] hover:border-slate-600 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            بروزرسانی
          </button>
          <button
            type="button"
            onClick={() => {
              setCreateError('');
              setShowAddModal(true);
            }}
            className="px-4 py-2 text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 rounded-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            تعریف کاربر جدید
          </button>
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

      <div className="bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-12 bg-[#0B0F17] rounded-lg animate-pulse" />
            ))}
          </div>
        ) : users.length === 0 ? (
          <div className="p-10 text-center space-y-2 text-xs text-slate-400">
            <Users className="w-7 h-7 mx-auto text-slate-500" />
            <p>کاربری ثبت نشده است.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-right">
              <thead className="bg-[#0B0F17] text-slate-400 border-b border-[#1F2937]">
                <tr>
                  <th className="py-3 px-4 font-medium">نام و نام کاربری</th>
                  <th className="py-3 px-4 font-medium">نقش</th>
                  <th className="py-3 px-4 font-medium">وضعیت</th>
                  <th className="py-3 px-4 font-medium">منابع اختصاصی</th>
                  <th className="py-3 px-4 font-medium text-left">عملیات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1F2937]">
                {users.map((u) => {
                  const isProtectedRoot = u.id === 'usr_admin' || u.id === currentUserId;
                  return (
                    <tr key={u.id} className="hover:bg-slate-800/25 transition-colors">
                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-slate-100">{u.displayName}</div>
                        <div className="font-mono text-[11px] text-slate-400 mt-0.5" dir="ltr">
                          @{u.username}
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        <span
                          className={`font-medium ${
                            u.role === 'admin' ? 'text-sky-400' : 'text-slate-300'
                          }`}
                        >
                          {u.role === 'admin' ? 'مدیر کل' : 'کاربر فضاهای خصوصی'}
                        </span>
                      </td>
                      <td className="py-3.5 px-4">
                        <span className={u.isActive ? 'text-emerald-400' : 'text-red-400'}>
                          {u.isActive ? 'فعال' : 'غیرفعال'}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-slate-300 tabular-nums">
                        {u.networksCount} شبکه · {u.projectsCount} پروژه · {u.servicesCount} سرویس
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="flex items-center justify-end gap-1.5 flex-wrap">
                          <button
                            type="button"
                            onClick={() => {
                              setResetTarget(u);
                              setResetPasswordVal('');
                              setResetError('');
                            }}
                            title="تغییر رمز عبور"
                            className="px-2.5 py-1.5 rounded-lg bg-[#0B0F17] border border-[#1F2937] hover:border-sky-500/50 text-slate-300 flex items-center gap-1 cursor-pointer whitespace-nowrap"
                          >
                            <Key className="w-3.5 h-3.5" />
                            <span>رمز جدید</span>
                          </button>

                          {!isProtectedRoot && (
                            <>
                              <button
                                type="button"
                                disabled={busyId === u.id}
                                onClick={() => handleToggleRole(u)}
                                title="تغییر نقش"
                                className="px-2.5 py-1.5 rounded-lg bg-[#0B0F17] border border-[#1F2937] hover:border-sky-500/50 text-slate-300 flex items-center gap-1 cursor-pointer whitespace-nowrap"
                              >
                                <Shield className="w-3.5 h-3.5" />
                                <span>{u.role === 'admin' ? 'تنزل به کاربر' : 'ارتقا به مدیر'}</span>
                              </button>

                              <button
                                type="button"
                                disabled={busyId === u.id}
                                onClick={() => handleToggleActive(u)}
                                title={u.isActive ? 'غیرفعال‌سازی' : 'فعال‌سازی'}
                                className={`p-1.5 rounded-lg bg-[#0B0F17] border border-[#1F2937] cursor-pointer ${
                                  u.isActive
                                    ? 'text-amber-400 hover:border-amber-500/50'
                                    : 'text-emerald-400 hover:border-emerald-500/50'
                                }`}
                              >
                                {u.isActive ? (
                                  <UserX className="w-3.5 h-3.5" />
                                ) : (
                                  <UserCheck className="w-3.5 h-3.5" />
                                )}
                              </button>

                              {confirmDeleteId === u.id ? (
                                <button
                                  type="button"
                                  disabled={busyId === u.id}
                                  onClick={() => handleDeleteUser(u.id)}
                                  className="px-2.5 py-1.5 rounded-lg bg-red-500 text-white font-medium cursor-pointer whitespace-nowrap"
                                >
                                  تایید حذف
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(u.id)}
                                  title="حذف کاربر"
                                  className="p-1.5 rounded-lg bg-[#0B0F17] border border-[#1F2937] hover:border-red-500/50 text-red-400 cursor-pointer"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </>
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

      {/* Add User Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-[#1F2937] flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-100">تعریف کاربر جدید</h2>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="text-slate-400 hover:text-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateUser} className="p-6 space-y-4 text-xs">
              {createError && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3.5 py-2.5 text-red-400">
                  {createError}
                </div>
              )}

              <div>
                <label className="block text-slate-300 mb-1">نام کاربری (انگلیسی، ۳ تا ۳۲ کاراکتر)</label>
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  dir="ltr"
                  placeholder="ali-dev"
                  className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 mb-1">نام نمایشی</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="علی محمدی"
                  className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 mb-1">رمز عبور (حداقل ۸ کاراکتر)</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  dir="ltr"
                  placeholder="••••••••"
                  className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 mb-1">سطح دسترسی</label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as 'member' | 'admin')}
                  className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-sky-500"
                >
                  <option value="member">کاربر عادی (شبکه‌ها، دیتابیس‌ها و پروژه‌های خودش)</option>
                  <option value="admin">مدیر کل (دسترسی کامل به کل سرور و کاربران)</option>
                </select>
              </div>

              <div className="pt-3 border-t border-[#1F2937] flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-slate-300 hover:text-slate-100 cursor-pointer"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-5 py-2 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-semibold rounded-lg cursor-pointer"
                >
                  {creating ? 'در حال ثبت...' : 'ایجاد حساب کاربری'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {resetTarget && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[#111827] border border-[#1F2937] rounded-xl overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-[#1F2937] flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-100">
                تغییر رمز عبور: {resetTarget.username}
              </h2>
              <button
                type="button"
                onClick={() => setResetTarget(null)}
                className="text-slate-400 hover:text-slate-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleResetPassword} className="p-6 space-y-4 text-xs">
              {resetError && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3.5 py-2.5 text-red-400">
                  {resetError}
                </div>
              )}

              <div>
                <label className="block text-slate-300 mb-1">رمز عبور جدید (حداقل ۸ کاراکتر)</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={resetPasswordVal}
                  onChange={(e) => setResetPasswordVal(e.target.value)}
                  dir="ltr"
                  placeholder="••••••••"
                  className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-sky-500"
                />
              </div>

              <div className="pt-3 border-t border-[#1F2937] flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setResetTarget(null)}
                  className="px-4 py-2 text-slate-300 hover:text-slate-100 cursor-pointer"
                >
                  انصراف
                </button>
                <button
                  type="submit"
                  disabled={resetting}
                  className="px-5 py-2 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-semibold rounded-lg cursor-pointer"
                >
                  {resetting ? 'در حال ذخیره...' : 'ثبت رمز عبور جدید'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
