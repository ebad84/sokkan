import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function getDataDir(): string {
  const raw = process.env.DATA_DIR?.trim();
  const dir = raw ? path.resolve(raw) : path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getWorkspacesDir(): string {
  const raw = process.env.WORKSPACES_DIR?.trim();
  const dir = raw ? path.resolve(raw) : path.join(getDataDir(), 'workspaces');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

const dbPath = path.join(getDataDir(), 'panel.db');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    repo_url TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT 'main',
    build_mode TEXT NOT NULL DEFAULT 'dockerfile',
    build_file_path TEXT NOT NULL DEFAULT 'Dockerfile',
    dockerfile_context TEXT NOT NULL DEFAULT '.',
    container_port INTEGER NOT NULL DEFAULT 3000,
    domain TEXT NOT NULL DEFAULT '',
    caddy_enabled INTEGER NOT NULL DEFAULT 1,
    caddy_extra_directives TEXT NOT NULL DEFAULT '',
    auto_deploy_webhook INTEGER NOT NULL DEFAULT 1,
    polling_interval_sec INTEGER NOT NULL DEFAULT 300,
    last_polled_at TEXT,
    github_token_enc TEXT NOT NULL DEFAULT '',
    webhook_secret_enc TEXT NOT NULL DEFAULT '',
    env_vars_enc TEXT NOT NULL DEFAULT '',
    last_commit_sha TEXT NOT NULL DEFAULT '',
    last_commit_msg TEXT NOT NULL DEFAULT '',
    last_deployed_at TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    status TEXT NOT NULL,
    commit_sha TEXT NOT NULL DEFAULT '',
    commit_message TEXT NOT NULL DEFAULT '',
    logs TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    execution_mode TEXT NOT NULL DEFAULT 'sandbox',
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS caddy_snapshots (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    note TEXT NOT NULL,
    applied INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS metric_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cpu_percent REAL NOT NULL,
    mem_percent REAL NOT NULL,
    mem_used_mb INTEGER NOT NULL,
    mem_total_mb INTEGER NOT NULL,
    disk_percent REAL NOT NULL,
    sampled_at TEXT NOT NULL
  );
`);

export const DEFAULT_CADDYFILE = `{
  email admin@example.com
  admin 0.0.0.0:2019
}

# BEGIN MANAGED ROUTES
# مسیرهای خودکار پروژه‌های سکان‌یار در این بخش قرار می‌گیرند
# END MANAGED ROUTES
`;

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}

export function claimAdminPasswordAtomic(passwordHash: string): boolean {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const existing = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('admin_password_hash') as { value: string } | undefined;
    if (existing) {
      return false;
    }
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      'admin_password_hash',
      passwordHash,
      now,
    );
    return true;
  });
  return tx();
}

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  repo_url: string;
  branch: string;
  build_mode: string;
  build_file_path: string;
  dockerfile_context: string;
  container_port: number;
  domain: string;
  caddy_enabled: number;
  caddy_extra_directives: string;
  auto_deploy_webhook: number;
  polling_interval_sec: number;
  last_polled_at: string | null;
  github_token_enc: string;
  webhook_secret_enc: string;
  env_vars_enc: string;
  last_commit_sha: string;
  last_commit_msg: string;
  last_deployed_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface DeploymentRow {
  id: string;
  project_id: string;
  trigger_type: string;
  status: string;
  commit_sha: string;
  commit_message: string;
  logs: string;
  started_at: string;
  finished_at: string | null;
  execution_mode: string;
}

export interface CaddySnapshotRow {
  id: string;
  content: string;
  note: string;
  applied: number;
  created_at: string;
}

function loadInitialCaddyfile(): string {
  const candidates = [process.env.CADDYFILE_PATH?.trim(), '/etc/caddy/Caddyfile'].filter(
    (p): p is string => Boolean(p),
  );
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        const text = fs.readFileSync(resolved, 'utf8');
        if (text.trim().length > 0) {
          return text;
        }
      }
    } catch {
      // Ignore unreadable path and fall back
    }
  }
  return DEFAULT_CADDYFILE;
}

if (!getSetting('caddyfile_content')) {
  const initialCaddy = loadInitialCaddyfile();
  setSetting('caddyfile_content', initialCaddy);
  db.prepare(
    'INSERT INTO caddy_snapshots (id, content, note, applied, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    `snap_${Date.now()}`,
    initialCaddy,
    'تنظیمات پایه اولیه Caddyfile',
    1,
    new Date().toISOString(),
  );
}
