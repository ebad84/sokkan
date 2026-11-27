import { useState, type FormEvent } from 'react';
import { apiFetch, setAuthToken } from '../api';
import type { AuthStatus, AuthUser } from '../types';
import { SokkanLogo } from './SokkanLogo';

interface AuthGateProps {
  authStatus: AuthStatus;
  onAuthenticated: (user: AuthUser) => void;
}

export function AuthGate({ authStatus, onAuthenticated }: AuthGateProps) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isSetup = authStatus.needsSetup;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (isSetup && password.length < 8) {
      setError('رمز عبور مدیر باید حداقل ۸ کاراکتر باشد.');
      return;
    }
    if (isSetup && password !== confirmPassword) {
      setError('تکرار رمز عبور مطابقت ندارد.');
      return;
    }

    setLoading(true);
    try {
      const endpoint = isSetup ? '/api/auth/setup' : '/api/auth/login';
      const payload = isSetup ? { password } : { username: username.trim() || 'admin', password };
      const data = await apiFetch<{ token: string; user: AuthUser }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setAuthToken(data.token);
      onAuthenticated(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در ورود به پنل');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0F17] flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-[#111827] border border-[#1F2937] rounded-xl p-8">
        <div className="flex items-center gap-3.5 mb-6">
          <SokkanLogo size={42} />
          <div>
            <h1 className="text-lg font-semibold text-slate-100">
              {isSetup ? 'تنظیم رمز مدیر سکان' : 'ورود به پنل سکان'}
            </h1>
            <p className="text-xs text-slate-400 mt-0.5">
              {isSetup
                ? 'اولین اجرا: رمز مدیر کل (admin) را برای مدیریت سرور، شبکه‌ها و کاربران تعریف کنید.'
                : authStatus.envPasscodeActive
                  ? 'نام کاربری و رمز عبور خود را وارد کنید.'
                  : 'با حساب مدیر (admin) یا نام کاربری تعریف‌شده وارد فضای کاری خود شوید.'}
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {!isSetup && (
            <div>
              <label htmlFor="panel-username" className="block text-xs font-medium text-slate-300 mb-1.5">
                نام کاربری
              </label>
              <input
                id="panel-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                dir="ltr"
                placeholder="admin"
                className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3.5 py-2.5 text-sm text-slate-100 font-mono focus:outline-none focus:border-sky-500 transition-colors"
              />
            </div>
          )}

          {isSetup && (
            <div className="bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3.5 py-2.5 flex items-center justify-between text-xs">
              <span className="text-slate-400">نام کاربری مدیر کل</span>
              <span className="font-mono text-sky-400">admin</span>
            </div>
          )}

          <div>
            <label htmlFor="panel-password" className="block text-xs font-medium text-slate-300 mb-1.5">
              {isSetup ? 'رمز عبور مدیر' : 'رمز عبور'}
            </label>
            <input
              id="panel-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus={isSetup}
              dir="ltr"
              placeholder={isSetup ? 'حداقل ۸ کاراکتر' : '••••••••'}
              className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3.5 py-2.5 text-sm text-slate-100 font-mono focus:outline-none focus:border-sky-500 transition-colors"
            />
          </div>

          {isSetup && (
            <div>
              <label htmlFor="panel-password-confirm" className="block text-xs font-medium text-slate-300 mb-1.5">
                تکرار رمز عبور
              </label>
              <input
                id="panel-password-confirm"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                dir="ltr"
                placeholder="تکرار رمز عبور"
                className="w-full bg-[#0B0F17] border border-[#1F2937] rounded-lg px-3.5 py-2.5 text-sm text-slate-100 font-mono focus:outline-none focus:border-sky-500 transition-colors"
              />
            </div>
          )}

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-semibold text-sm transition-colors cursor-pointer whitespace-nowrap"
          >
            {loading
              ? 'در حال بررسی...'
              : isSetup
                ? 'ثبت رمز و ورود به داشبورد'
                : 'ورود به پنل'}
          </button>
        </form>
      </div>
    </div>
  );
}
