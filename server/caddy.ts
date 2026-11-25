import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_CADDYFILE,
  db,
  getSetting,
  setSetting,
  type CaddySnapshotRow,
  type ProjectRow,
} from './db.ts';

const execFileAsync = promisify(execFile);

const BEGIN_MARKER = '# BEGIN MANAGED ROUTES';
const END_MARKER = '# END MANAGED ROUTES';

export function getCaddyfileDiskPath(): string | null {
  const raw = process.env.CADDYFILE_PATH?.trim();
  if (raw) {
    return path.resolve(raw);
  }
  const defaultVpsPath = '/etc/caddy/Caddyfile';
  if (fs.existsSync(defaultVpsPath)) {
    return defaultVpsPath;
  }
  return null;
}

export function getCaddyAdminUrl(): string | null {
  const raw = process.env.CADDY_ADMIN_URL?.trim();
  if (raw) {
    return raw.replace(/\/+$/, '');
  }
  return 'http://127.0.0.1:2019';
}

export function getCaddyContainerName(): string {
  const raw = process.env.CADDY_CONTAINER_NAME?.trim();
  return raw && /^[a-zA-Z0-9_.-]+$/.test(raw) ? raw : 'caddy';
}

export type CaddyMode = 'admin_api' | 'docker_exec' | 'cli' | 'none';

export async function isCaddyAvailable(): Promise<{ reachable: boolean; mode: CaddyMode }> {
  const adminUrl = getCaddyAdminUrl();
  if (adminUrl) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${adminUrl}/config/`, { signal: controller.signal });
      clearTimeout(t);
      if (res.ok || res.status === 404) {
        return { reachable: true, mode: 'admin_api' };
      }
    } catch {
      // Fallback to Docker Exec / CLI check
    }
  }
  try {
    const containerName = getCaddyContainerName();
    await execFileAsync('docker', ['exec', containerName, 'caddy', 'version'], { timeout: 2500 });
    return { reachable: true, mode: 'docker_exec' };
  } catch {
    // Fallback to local Caddy CLI check
  }
  try {
    await execFileAsync('caddy', ['version'], { timeout: 1500 });
    return { reachable: true, mode: 'cli' };
  } catch {
    return { reachable: false, mode: 'none' };
  }
}

export function validateDomainString(domain: string): boolean {
  const trimmed = domain.trim();
  if (!trimmed) return false;
  // Allow hostnames, wildcards, or :port patterns without whitespace/braces/semicolons
  return /^[a-zA-Z0-9.*:_-]+$/.test(trimmed) && !trimmed.includes('..');
}

export function renderManagedRoutesBlock(projects: ProjectRow[]): string {
  const active = projects.filter((p) => p.caddy_enabled === 1 && p.domain.trim().length > 0);
  if (active.length === 0) {
    return `${BEGIN_MARKER}\n# هنوز دامنه‌ای برای پروژه‌ها فعال نشده است\n${END_MARKER}`;
  }

  const blocks = active.map((p) => {
    const safeDomain = p.domain.trim();
    const upstream = `sokanyar-${p.slug}:${p.container_port}`;
    const extraLines = p.caddy_extra_directives
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => `  ${l}`)
      .join('\n');

    return `${safeDomain} {
  encode zstd gzip
  reverse_proxy ${upstream}${extraLines ? `\n${extraLines}` : ''}
}`;
  });

  return `${BEGIN_MARKER}\n${blocks.join('\n\n')}\n${END_MARKER}`;
}

export function mergeManagedRoutesIntoCaddyfile(existingContent: string, projects: ProjectRow[]): string {
  const base = existingContent?.trim() ? existingContent : DEFAULT_CADDYFILE;
  const managedBlock = renderManagedRoutesBlock(projects);

  const beginIdx = base.indexOf(BEGIN_MARKER);
  const endIdx = base.indexOf(END_MARKER);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = base.slice(0, beginIdx).trimEnd();
    const after = base.slice(endIdx + END_MARKER.length).trimStart();
    return `${before}\n\n${managedBlock}${after ? `\n\n${after}` : '\n'}`;
  }

  return `${base.trimEnd()}\n\n${managedBlock}\n`;
}

export function checkCaddySyntaxLocally(content: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  let depth = 0;
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const clean = line.replace(/#.*$/, '');
    for (const ch of clean) {
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      if (depth < 0) {
        errors.push(`خط ${idx + 1}: آکولاد بسته اضافی '}' وجود دارد.`);
        depth = 0;
      }
    }
  });

  if (depth !== 0) {
    errors.push('تعداد آکولادهای باز و بسته در Caddyfile برابر نیست.');
  }
  if (!content.trim()) {
    errors.push('محتوای Caddyfile نمی‌تواند خالی باشد.');
  }
  return { valid: errors.length === 0, errors };
}

function formatExecError(err: unknown, fallback: string): string {
  if (err && typeof err === 'object') {
    const stderr = 'stderr' in err && typeof err.stderr === 'string' ? err.stderr.trim() : '';
    const stdout = 'stdout' in err && typeof err.stdout === 'string' ? err.stdout.trim() : '';
    if (stderr) return stderr;
    if (stdout) return stdout;
  }
  return err instanceof Error ? err.message : fallback;
}

export async function validateCaddyfile(
  content: string,
): Promise<{
  valid: boolean;
  errors: string[];
  validatedBy: 'caddy_api' | 'caddy_docker' | 'caddy_cli' | 'syntax_checker';
}> {
  const local = checkCaddySyntaxLocally(content);
  if (!local.valid) {
    return { valid: false, errors: local.errors, validatedBy: 'syntax_checker' };
  }

  const caddyStatus = await isCaddyAvailable();
  if (caddyStatus.reachable && caddyStatus.mode === 'admin_api') {
    const adminUrl = getCaddyAdminUrl();
    if (adminUrl) {
      try {
        const res = await fetch(`${adminUrl}/adapt`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/caddyfile' },
          body: content,
        });
        if (!res.ok) {
          const msg = await res.text();
          return {
            valid: false,
            errors: [msg || `خطای اعتبارسنجی Caddy Admin API (${res.status})`],
            validatedBy: 'caddy_api',
          };
        }
        return { valid: true, errors: [], validatedBy: 'caddy_api' };
      } catch {
        // Fallback to local
      }
    }
  }

  if (caddyStatus.reachable && caddyStatus.mode === 'docker_exec') {
    const containerName = getCaddyContainerName();
    const diskPath = getCaddyfileDiskPath();
    if (diskPath && fs.existsSync(path.dirname(diskPath))) {
      const tmpName = `.Caddyfile.validate.${Date.now()}.tmp`;
      const hostTmpPath = path.join(path.dirname(diskPath), tmpName);
      const containerTmpPath = path.posix.join('/etc/caddy', tmpName);
      try {
        fs.writeFileSync(hostTmpPath, content, 'utf8');
        await execFileAsync(
          'docker',
          ['exec', containerName, 'caddy', 'validate', '--config', containerTmpPath, '--adapter', 'caddyfile'],
          { timeout: 8000 },
        );
        return { valid: true, errors: [], validatedBy: 'caddy_docker' };
      } catch (err) {
        return {
          valid: false,
          errors: [formatExecError(err, 'خطا در اعتبارسنجی Caddyfile داخل کانتینر Caddy')],
          validatedBy: 'caddy_docker',
        };
      } finally {
        if (fs.existsSync(hostTmpPath)) {
          fs.unlinkSync(hostTmpPath);
        }
      }
    }
  }

  if (caddyStatus.reachable && caddyStatus.mode === 'cli') {
    const tmpPath = path.join('/tmp', `caddy-validate-${Date.now()}.Caddyfile`);
    try {
      fs.writeFileSync(tmpPath, content, 'utf8');
      await execFileAsync('caddy', ['validate', '--config', tmpPath, '--adapter', 'caddyfile'], {
        timeout: 5000,
      });
      return { valid: true, errors: [], validatedBy: 'caddy_cli' };
    } catch (err) {
      return {
        valid: false,
        errors: [formatExecError(err, 'خطا در اعتبارسنجی Caddyfile')],
        validatedBy: 'caddy_cli',
      };
    } finally {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    }
  }

  return { valid: true, errors: [], validatedBy: 'syntax_checker' };
}

export async function applyCaddyfile(
  content: string,
  note = 'به‌روزرسانی دستی Caddyfile',
): Promise<{
  ok: boolean;
  appliedToLiveCaddy: boolean;
  validatedBy: string;
  snapshotId: string;
  message: string;
}> {
  const validation = await validateCaddyfile(content);
  if (!validation.valid) {
    throw new Error(validation.errors.join(' | '));
  }

  const prevContent = getSetting('caddyfile_content') ?? DEFAULT_CADDYFILE;
  const diskPath = getCaddyfileDiskPath();
  let appliedToLiveCaddy = false;

  if (diskPath) {
    const parent = path.dirname(diskPath);
    if (fs.existsSync(parent)) {
      fs.writeFileSync(diskPath, content, 'utf8');
    }
  }

  const caddyStatus = await isCaddyAvailable();
  if (caddyStatus.reachable && caddyStatus.mode === 'admin_api') {
    const adminUrl = getCaddyAdminUrl();
    if (adminUrl) {
      const res = await fetch(`${adminUrl}/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/caddyfile' },
        body: content,
      });
      if (!res.ok) {
        const errText = await res.text();
        if (diskPath && fs.existsSync(path.dirname(diskPath))) {
          fs.writeFileSync(diskPath, prevContent, 'utf8');
        }
        throw new Error(`بارگذاری تنظیمات در Caddy با خطا مواجه شد و بازگردانی شد: ${errText}`);
      }
      appliedToLiveCaddy = true;
    }
  } else if (caddyStatus.reachable && caddyStatus.mode === 'docker_exec' && diskPath) {
    const containerName = getCaddyContainerName();
    try {
      await execFileAsync(
        'docker',
        ['exec', containerName, 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
        { timeout: 10000 },
      );
      appliedToLiveCaddy = true;
    } catch (err) {
      fs.writeFileSync(diskPath, prevContent, 'utf8');
      const msg = formatExecError(err, 'خطا در reload کردن کانتینر Caddy');
      throw new Error(`خطا در اعمال Caddyfile روی کانتینر Caddy و بازگشت خودکار به نسخه قبلی: ${msg}`);
    }
  } else if (caddyStatus.reachable && caddyStatus.mode === 'cli' && diskPath) {
    try {
      await execFileAsync('caddy', ['reload', '--config', diskPath, '--adapter', 'caddyfile'], {
        timeout: 8000,
      });
      appliedToLiveCaddy = true;
    } catch (err) {
      fs.writeFileSync(diskPath, prevContent, 'utf8');
      const msg = formatExecError(err, 'خطا در reload کردن Caddy');
      throw new Error(`خطا در اعمال Caddyfile و بازگشت خودکار به نسخه قبلی: ${msg}`);
    }
  }

  setSetting('caddyfile_content', content);
  const snapshotId = `snap_${Date.now()}`;
  db.prepare(
    'INSERT INTO caddy_snapshots (id, content, note, applied, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(snapshotId, content, note, appliedToLiveCaddy ? 1 : 0, new Date().toISOString());

  return {
    ok: true,
    appliedToLiveCaddy,
    validatedBy: validation.validatedBy,
    snapshotId,
    message: appliedToLiveCaddy
      ? 'تغییرات روی Caddy زنده سرور با موفقیت اعمال و Reload شد.'
      : 'تنظیمات فقط در فایل و دیتابیس ذخیره شد (اتصال به Caddy زنده برقرار نبود — روی سرور با docker exec caddy caddy reload اعمال کنید).',
  };
}

export async function syncProjectsToCaddyfile(note = 'همگام‌سازی خودکار مسیرهای پروژه'): Promise<void> {
  const projects = db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all() as ProjectRow[];
  const current = getSetting('caddyfile_content') ?? DEFAULT_CADDYFILE;
  const next = mergeManagedRoutesIntoCaddyfile(current, projects);
  if (next !== current) {
    await applyCaddyfile(next, note);
  }
}

export function listCaddySnapshots(limit = 20): CaddySnapshotRow[] {
  return db
    .prepare('SELECT * FROM caddy_snapshots ORDER BY created_at DESC LIMIT ?')
    .all(limit) as CaddySnapshotRow[];
}
