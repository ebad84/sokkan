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

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    password_hash TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS private_networks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    docker_name TEXT UNIQUE NOT NULL,
    owner_user_id TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    subnet TEXT NOT NULL DEFAULT '',
    internal_only INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS network_attachments (
    id TEXT PRIMARY KEY,
    network_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    alias TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(network_id, resource_type, resource_id),
    FOREIGN KEY (network_id) REFERENCES private_networks(id) ON DELETE CASCADE
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
    owner_user_id TEXT NOT NULL DEFAULT 'usr_admin',
    private_network_id TEXT,
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

  CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    image TEXT NOT NULL,
    category TEXT NOT NULL,
    container_port INTEGER NOT NULL,
    domain TEXT NOT NULL DEFAULT '',
    caddy_enabled INTEGER NOT NULL DEFAULT 0,
    mem_limit_mb INTEGER NOT NULL DEFAULT 256,
    env_vars_enc TEXT NOT NULL DEFAULT '',
    volumes_json TEXT NOT NULL DEFAULT '[]',
    command_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'idle',
    last_message TEXT NOT NULL DEFAULT '',
    owner_user_id TEXT NOT NULL DEFAULT 'usr_admin',
    private_network_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

function ensureColumn(tableName: 'projects' | 'services', columnName: string, columnSql: string): void {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql}`);
  }
}

ensureColumn('projects', 'owner_user_id', "owner_user_id TEXT NOT NULL DEFAULT 'usr_admin'");
ensureColumn('projects', 'private_network_id', 'private_network_id TEXT');
ensureColumn('projects', 'deploy_strategy', "deploy_strategy TEXT NOT NULL DEFAULT 'local'");
ensureColumn('projects', 'ghcr_image', "ghcr_image TEXT NOT NULL DEFAULT ''");
ensureColumn('projects', 'actions_compose_file', "actions_compose_file TEXT NOT NULL DEFAULT ''");
ensureColumn('services', 'owner_user_id', "owner_user_id TEXT NOT NULL DEFAULT 'usr_admin'");
ensureColumn('services', 'private_network_id', 'private_network_id TEXT');

export const DEFAULT_CADDYFILE = `{
  email admin@example.com
  admin 0.0.0.0:2019
}

# BEGIN MANAGED ROUTES
# مسیرهای خودکار پروژه‌های سکان در این بخش قرار می‌گیرند
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

// Ensure root admin row exists in `users` if legacy admin_password_hash or env passcode is present
function syncLegacyAdminUser(): void {
  const now = new Date().toISOString();
  const existingAdmin = db
    .prepare("SELECT * FROM users WHERE username = 'admin' OR id = 'usr_admin'")
    .get() as UserRow | undefined;
  const legacyHash = getSetting('admin_password_hash');
  const envPasscodeActive = (process.env.PANEL_ADMIN_PASSCODE?.trim() ?? '').length > 0;

  if (!existingAdmin && (legacyHash || envPasscodeActive)) {
    db.prepare(
      `INSERT INTO users (id, username, display_name, role, password_hash, is_active, created_at, updated_at)
       VALUES ('usr_admin', 'admin', 'مدیر کل سیستم', 'admin', ?, 1, ?, ?)`,
    ).run(legacyHash || '', now, now);
  } else if (existingAdmin && !existingAdmin.password_hash && legacyHash) {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
      legacyHash,
      now,
      existingAdmin.id,
    );
  }
}

export function recoverStaleBuilds(): void {
  const now = new Date().toISOString();
  const note = `\n[${now.slice(11, 19)}] فرآیند بیلد به دلیل ری‌استارت شدن سرور نیمه‌تمام ماند و متوقف شد.\n`;
  db.prepare(
    `UPDATE deployments
     SET status = 'failed', finished_at = COALESCE(finished_at, ?), logs = logs || ?
     WHERE status = 'building'`,
  ).run(now, note);
  db.prepare(
    `UPDATE projects SET status = 'error', updated_at = ? WHERE status = 'building'`,
  ).run(now);
}

export function claimAdminPasswordAtomic(passwordHash: string): boolean {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const existing = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('admin_password_hash') as { value: string } | undefined;
    const existingAdminUser = db
      .prepare("SELECT id FROM users WHERE username = 'admin'")
      .get() as { id: string } | undefined;
    if (existing || existingAdminUser) {
      return false;
    }
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      'admin_password_hash',
      passwordHash,
      now,
    );
    db.prepare(
      `INSERT INTO users (id, username, display_name, role, password_hash, is_active, created_at, updated_at)
       VALUES ('usr_admin', 'admin', 'مدیر کل سیستم', 'admin', ?, 1, ?, ?)`,
    ).run(passwordHash, now, now);
    return true;
  });
  return tx();
}

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'member';
  password_hash: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface PrivateNetworkRow {
  id: string;
  name: string;
  slug: string;
  docker_name: string;
  owner_user_id: string;
  description: string;
  subnet: string;
  internal_only: number;
  created_at: string;
  updated_at: string;
}

export interface NetworkAttachmentRow {
  id: string;
  network_id: string;
  resource_type: 'project' | 'service';
  resource_id: string;
  alias: string;
  created_at: string;
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
  owner_user_id: string;
  deploy_strategy: string;
  ghcr_image: string;
  actions_compose_file: string;
  private_network_id: string | null;
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

export interface ServiceRow {
  id: string;
  template_id: string;
  name: string;
  slug: string;
  image: string;
  category: string;
  container_port: number;
  domain: string;
  caddy_enabled: number;
  mem_limit_mb: number;
  env_vars_enc: string;
  volumes_json: string;
  command_json: string;
  status: string;
  last_message: string;
  owner_user_id: string;
  private_network_id: string | null;
  created_at: string;
  updated_at: string;
}

export function getResourcePrivateNetworks(
  resourceType: 'project' | 'service',
  resourceId: string,
  primaryNetworkId?: string | null,
): PrivateNetworkRow[] {
  const attached = db
    .prepare(
      `SELECT pn.* FROM private_networks pn
       INNER JOIN network_attachments na ON na.network_id = pn.id
       WHERE na.resource_type = ? AND na.resource_id = ?
       ORDER BY pn.created_at ASC`,
    )
    .all(resourceType, resourceId) as PrivateNetworkRow[];

  if (!primaryNetworkId) {
    return attached;
  }

  const primary = db
    .prepare('SELECT * FROM private_networks WHERE id = ?')
    .get(primaryNetworkId) as PrivateNetworkRow | undefined;

  if (!primary) {
    return attached;
  }

  const rest = attached.filter((n) => n.id !== primary.id);
  return [primary, ...rest];
}

export function syncPrimaryNetworkAttachment(
  resourceType: 'project' | 'service',
  resourceId: string,
  slug: string,
  nextPrimaryNetworkId: string | null,
  prevPrimaryNetworkId?: string | null,
): void {
  if (prevPrimaryNetworkId && prevPrimaryNetworkId !== nextPrimaryNetworkId) {
    db.prepare(
      'DELETE FROM network_attachments WHERE network_id = ? AND resource_type = ? AND resource_id = ?',
    ).run(prevPrimaryNetworkId, resourceType, resourceId);
  }
  if (nextPrimaryNetworkId) {
    const now = new Date().toISOString();
    const id = `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(
      `INSERT INTO network_attachments (id, network_id, resource_type, resource_id, alias, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(network_id, resource_type, resource_id) DO NOTHING`,
    ).run(id, nextPrimaryNetworkId, resourceType, resourceId, slug, now);
  }
}

syncLegacyAdminUser();
recoverStaleBuilds();

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
