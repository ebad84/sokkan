import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { decryptSecret, generateRandomHex } from './crypto.ts';
import { getDataDir, getResourcePrivateNetworks, type ServiceRow } from './db.ts';
import {
  connectContainerToNetwork,
  ensureDockerNetwork,
  isDockerAvailable,
  performContainerAction,
} from './docker.ts';

const execFileAsync = promisify(execFile);

export type TemplateCategory = 'database' | 'app' | 'tool';

export interface TemplateEnvField {
  key: string;
  label: string;
  defaultValue?: string;
  autoGenerate?: 'password' | 'hex32';
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
}

export interface ServiceTemplate {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  category: TemplateCategory;
  image: string;
  defaultSlug: string;
  containerPort: number;
  supportsDomain: boolean;
  defaultMemLimitMb: number;
  volumes: Array<{ name: string; mountPath: string }>;
  commandTemplate?: string[];
  envFields: TemplateEnvField[];
  connectionHint?: string;
}

export const SERVICE_TEMPLATES: ServiceTemplate[] = [
  {
    id: 'postgres',
    name: 'PostgreSQL 16',
    subtitle: 'دیتابیس رابطه‌ای قدرتمند',
    description: 'نسخه سبک Alpine از PostgreSQL با Volume دائمی و دسترسی ایزوله روی شبکه داخلی web.',
    category: 'database',
    image: 'postgres:16-alpine',
    defaultSlug: 'postgres-db',
    containerPort: 5432,
    supportsDomain: false,
    defaultMemLimitMb: 256,
    volumes: [{ name: 'data', mountPath: '/var/lib/postgresql/data' }],
    envFields: [
      { key: 'POSTGRES_DB', label: 'نام دیتابیس', defaultValue: 'appdb', required: true },
      { key: 'POSTGRES_USER', label: 'نام کاربری', defaultValue: 'appuser', required: true },
      {
        key: 'POSTGRES_PASSWORD',
        label: 'رمز عبور',
        autoGenerate: 'password',
        secret: true,
        required: true,
      },
    ],
  },
  {
    id: 'redis',
    name: 'Redis 7',
    subtitle: 'کش سریع و صف پیام در حافظه',
    description: 'نسخه سبک Redis با ذخیره دائمی AOF و رمز عبور خودکار برای کش، نشست‌ها و صف‌های پس‌زمینه.',
    category: 'database',
    image: 'redis:7-alpine',
    defaultSlug: 'redis-cache',
    containerPort: 6379,
    supportsDomain: false,
    defaultMemLimitMb: 128,
    volumes: [{ name: 'data', mountPath: '/data' }],
    commandTemplate: ['redis-server', '--appendonly', 'yes', '--requirepass', '${REDIS_PASSWORD}'],
    envFields: [
      {
        key: 'REDIS_PASSWORD',
        label: 'رمز عبور Redis',
        autoGenerate: 'password',
        secret: true,
        required: true,
      },
    ],
  },
  {
    id: 'mariadb',
    name: 'MariaDB 11',
    subtitle: 'دیتابیس سازگار با MySQL',
    description: 'مناسب برای پروژه‌های PHP، وردپرس، لاراول و اپ‌های مبتنی بر MySQL با ذخیره دائمی داده.',
    category: 'database',
    image: 'mariadb:11',
    defaultSlug: 'mariadb-db',
    containerPort: 3306,
    supportsDomain: false,
    defaultMemLimitMb: 256,
    volumes: [{ name: 'data', mountPath: '/var/lib/mysql' }],
    envFields: [
      { key: 'MARIADB_DATABASE', label: 'نام دیتابیس', defaultValue: 'appdb', required: true },
      { key: 'MARIADB_USER', label: 'نام کاربری', defaultValue: 'appuser', required: true },
      {
        key: 'MARIADB_PASSWORD',
        label: 'رمز کاربر',
        autoGenerate: 'password',
        secret: true,
        required: true,
      },
      {
        key: 'MARIADB_ROOT_PASSWORD',
        label: 'رمز Root',
        autoGenerate: 'password',
        secret: true,
        required: true,
      },
    ],
  },
  {
    id: 'mongodb',
    name: 'MongoDB 7',
    subtitle: 'دیتابیس سندمحور NoSQL',
    description: 'مناسب اپ‌های Node.js و داده‌های بدون ساختار با احراز هویت فعال و Volume دائمی.',
    category: 'database',
    image: 'mongo:7',
    defaultSlug: 'mongo-db',
    containerPort: 27017,
    supportsDomain: false,
    defaultMemLimitMb: 300,
    volumes: [{ name: 'data', mountPath: '/data/db' }],
    envFields: [
      { key: 'MONGO_INITDB_ROOT_USERNAME', label: 'نام کاربری Root', defaultValue: 'admin', required: true },
      {
        key: 'MONGO_INITDB_ROOT_PASSWORD',
        label: 'رمز عبور Root',
        autoGenerate: 'password',
        secret: true,
        required: true,
      },
    ],
  },
  {
    id: 'n8n',
    name: 'n8n',
    subtitle: 'اتوماسیون ورک‌فلو و وب‌هوک',
    description: 'ساخت جریان‌های خودکار بدون کد (اتصال تلگرام، گیتهاب، APIها و دیتابیس) با SSL خودکار Caddy.',
    category: 'app',
    image: 'n8nio/n8n:latest',
    defaultSlug: 'n8n',
    containerPort: 5678,
    supportsDomain: true,
    defaultMemLimitMb: 384,
    volumes: [{ name: 'data', mountPath: '/home/node/.n8n' }],
    envFields: [
      { key: 'GENERIC_TIMEZONE', label: 'منطقه زمانی', defaultValue: 'Asia/Tehran' },
      { key: 'N8N_ENCRYPTION_KEY', label: 'کلید رمزنگاری', autoGenerate: 'hex32', secret: true },
    ],
  },
  {
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    subtitle: 'مانیتورینگ آپتایم و صفحه وضعیت',
    description: 'پایش مداوم سایت‌ها، APIها و پورت‌ها با هشدار تلگرام/وب‌هوک و ساخت Status Page عمومی.',
    category: 'app',
    image: 'louislam/uptime-kuma:2',
    defaultSlug: 'kuma-app',
    containerPort: 3001,
    supportsDomain: true,
    defaultMemLimitMb: 200,
    volumes: [{ name: 'data', mountPath: '/app/data' }],
    envFields: [],
  },
  {
    id: 'minio',
    name: 'MinIO Object Storage',
    subtitle: 'فضای ذخیره‌سازی سازگار با S3',
    description: 'آپلود و نگهداری فایل‌ها، تصاویر و بکاپ‌ها با API استاندارد AWS S3 و کنسول وب داخلی.',
    category: 'app',
    image: 'minio/minio:latest',
    defaultSlug: 'minio',
    containerPort: 9001,
    supportsDomain: true,
    defaultMemLimitMb: 256,
    volumes: [{ name: 'data', mountPath: '/data' }],
    commandTemplate: ['server', '/data', '--console-address', ':9001'],
    envFields: [
      { key: 'MINIO_ROOT_USER', label: 'نام کاربری ادمین', defaultValue: 'minioadmin', required: true },
      {
        key: 'MINIO_ROOT_PASSWORD',
        label: 'رمز عبور ادمین (حداقل ۸ کاراکتر)',
        autoGenerate: 'password',
        secret: true,
        required: true,
      },
    ],
  },
  {
    id: 'memos',
    name: 'Memos',
    subtitle: 'یادداشت‌برداری و پایگاه دانش سبک',
    description: 'سرویس فوق‌سبک یادداشت و مستندسازی تیمی/شخصی با SQLite داخلی (مصرف رم زیر ۵۰ مگابایت).',
    category: 'app',
    image: 'neosmemo/memos:stable',
    defaultSlug: 'memos',
    containerPort: 5230,
    supportsDomain: true,
    defaultMemLimitMb: 128,
    volumes: [{ name: 'data', mountPath: '/var/opt/memos' }],
    envFields: [],
  },
  {
    id: 'vaultwarden',
    name: 'Vaultwarden',
    subtitle: 'مدیریت رمز عبور سازگار با Bitwarden',
    description: 'سرور سبک Rust سازگار با اپ‌های موبایل و افزونه مرورگر Bitwarden با مصرف رم بسیار کم.',
    category: 'tool',
    image: 'vaultwarden/server:latest',
    defaultSlug: 'vault',
    containerPort: 80,
    supportsDomain: true,
    defaultMemLimitMb: 128,
    volumes: [{ name: 'data', mountPath: '/data' }],
    envFields: [
      { key: 'SIGNUPS_ALLOWED', label: 'اجازه ثبت‌نام جدید (true/false)', defaultValue: 'true' },
    ],
  },
  {
    id: 'adminer',
    name: 'Adminer',
    subtitle: 'پنل وب سبک مدیریت دیتابیس‌ها',
    description: 'مدیریت مستقیم PostgreSQL، MariaDB و MySQL از مرورگر روی شبکه داخلی web (مصرف رم زیر ۴۰ مگابایت).',
    category: 'tool',
    image: 'adminer:latest',
    defaultSlug: 'adminer',
    containerPort: 8080,
    supportsDomain: true,
    defaultMemLimitMb: 96,
    volumes: [],
    envFields: [
      { key: 'ADMINER_DEFAULT_SERVER', label: 'نام کانتینر دیتابیس پیش‌فرض', defaultValue: 'sokkan-postgres-db' },
    ],
  },
];

export function findServiceTemplate(templateId: string): ServiceTemplate | undefined {
  return SERVICE_TEMPLATES.find((t) => t.id === templateId);
}

export function buildServiceEnvWithDefaults(
  template: ServiceTemplate,
  inputEnv: Record<string, string>,
  domain: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of template.envFields) {
    const provided = (inputEnv[field.key] ?? '').trim();
    if (provided) {
      result[field.key] = provided;
    } else if (field.autoGenerate === 'password') {
      result[field.key] = generateRandomHex(12);
    } else if (field.autoGenerate === 'hex32') {
      result[field.key] = generateRandomHex(24);
    } else if (field.defaultValue !== undefined) {
      result[field.key] = field.defaultValue;
    }
  }
  for (const [k, v] of Object.entries(inputEnv)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && v.trim() !== '' && !(k in result)) {
      result[k] = v.trim();
    }
  }
  if (template.id === 'n8n' && domain) {
    result.N8N_HOST = domain;
    result.WEBHOOK_URL = `https://${domain}/`;
    result.N8N_PROTOCOL = 'https';
  }
  if (template.id === 'vaultwarden' && domain) {
    result.DOMAIN = `https://${domain}`;
  }
  return result;
}

export function resolveCommandTemplate(
  commandTemplate: string[] | undefined,
  envMap: Record<string, string>,
): string[] {
  if (!commandTemplate || commandTemplate.length === 0) return [];
  return commandTemplate.map((token) =>
    token.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, key: string) => envMap[key] ?? ''),
  );
}

export function buildConnectionSummary(
  row: ServiceRow,
  envMap: Record<string, string>,
): { internalHost: string; connectionUrl: string } {
  const host = `sokkan-${row.slug}`;
  const internalHost = `${host}:${row.container_port}`;
  switch (row.template_id) {
    case 'postgres': {
      const user = envMap.POSTGRES_USER || 'appuser';
      const pass = envMap.POSTGRES_PASSWORD || '****';
      const dbName = envMap.POSTGRES_DB || 'appdb';
      return {
        internalHost,
        connectionUrl: `postgresql://${user}:${pass}@${host}:5432/${dbName}`,
      };
    }
    case 'redis': {
      const pass = envMap.REDIS_PASSWORD || '';
      return {
        internalHost,
        connectionUrl: pass ? `redis://:${pass}@${host}:6379` : `redis://${host}:6379`,
      };
    }
    case 'mariadb': {
      const user = envMap.MARIADB_USER || 'appuser';
      const pass = envMap.MARIADB_PASSWORD || '****';
      const dbName = envMap.MARIADB_DATABASE || 'appdb';
      return {
        internalHost,
        connectionUrl: `mysql://${user}:${pass}@${host}:3306/${dbName}`,
      };
    }
    case 'mongodb': {
      const user = envMap.MONGO_INITDB_ROOT_USERNAME || 'admin';
      const pass = envMap.MONGO_INITDB_ROOT_PASSWORD || '****';
      return {
        internalHost,
        connectionUrl: `mongodb://${user}:${pass}@${host}:27017/?authSource=admin`,
      };
    }
    default:
      return {
        internalHost,
        connectionUrl: row.domain ? `https://${row.domain}` : `http://${internalHost}`,
      };
  }
}

export function serializeService(row: ServiceRow) {
  let envMap: Record<string, string> = {};
  try {
    envMap = JSON.parse(decryptSecret(row.env_vars_enc) || '{}') as Record<string, string>;
  } catch {
    envMap = {};
  }
  const { internalHost, connectionUrl } = buildConnectionSummary(row, envMap);
  const networks = getResourcePrivateNetworks('service', row.id, row.private_network_id).map((n) => ({
    id: n.id,
    name: n.name,
    slug: n.slug,
    dockerName: n.docker_name,
    internalOnly: n.internal_only === 1,
  }));

  return {
    id: row.id,
    templateId: row.template_id,
    name: row.name,
    slug: row.slug,
    containerName: `sokkan-${row.slug}`,
    image: row.image,
    category: row.category,
    containerPort: row.container_port,
    domain: row.domain,
    caddyEnabled: row.caddy_enabled === 1,
    memLimitMb: row.mem_limit_mb,
    envKeys: Object.keys(envMap),
    internalHost,
    connectionUrl,
    status: row.status,
    lastMessage: row.last_message,
    ownerUserId: row.owner_user_id,
    privateNetworkId: row.private_network_id,
    networks,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function deployServiceInstance(row: ServiceRow): Promise<{
  executionMode: 'vps' | 'sandbox';
  status: 'running' | 'error';
  message: string;
}> {
  const containerName = `sokkan-${row.slug}`;
  const privateNets = getResourcePrivateNetworks('service', row.id, row.private_network_id);
  const fallbackNetwork = process.env.DOCKER_NETWORK?.trim() || 'web';
  const primaryNetwork = privateNets[0]?.docker_name || fallbackNetwork;
  const networkLabel =
    privateNets.length > 0
      ? privateNets.map((n) => `${n.name} (${n.docker_name})`).join('، ')
      : fallbackNetwork;

  const envMap = JSON.parse(decryptSecret(row.env_vars_enc) || '{}') as Record<string, string>;
  const volumes = JSON.parse(row.volumes_json || '[]') as Array<{ name: string; mountPath: string }>;
  const cmdArgs = JSON.parse(row.command_json || '[]') as string[];

  const dockerUp = await isDockerAvailable();
  if (!dockerUp) {
    return {
      executionMode: 'sandbox',
      status: 'running',
      message: `ثبت شد (حالت پیش‌نمایش بدون داکر) — روی VPS کانتینر ${containerName} (نام میزبان جایگزین: ${row.slug}) با ایمیج ${row.image} روی شبکه ${networkLabel} اجرا می‌شود.`,
    };
  }

  try {
    if (privateNets.length > 0) {
      for (const net of privateNets) {
        await ensureDockerNetwork(net.docker_name, {
          internal: net.internal_only === 1,
          subnet: net.subnet || undefined,
          ownerUserId: net.owner_user_id,
        });
      }
    } else {
      await ensureDockerNetwork(fallbackNetwork);
    }

    // Pull latest requested tag (uses Iranian registry mirrors configured in daemon.json)
    await execFileAsync('docker', ['pull', row.image], { timeout: 180_000 });

    // Remove existing container if re-deploying
    await execFileAsync('docker', ['rm', '-f', containerName], { timeout: 15_000 }).catch(() => {});

    const envDir = path.join(getDataDir(), 'service-envs');
    if (!fs.existsSync(envDir)) {
      fs.mkdirSync(envDir, { recursive: true, mode: 0o700 });
    }
    const envFilePath = path.join(envDir, `${row.slug}.env`);
    const envEntries = Object.entries(envMap).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
    if (envEntries.length > 0) {
      const content =
        envEntries.map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, ' ')}`).join('\n') + '\n';
      fs.writeFileSync(envFilePath, content, { mode: 0o600 });
    } else if (fs.existsSync(envFilePath)) {
      fs.unlinkSync(envFilePath);
    }

    const runArgs: string[] = [
      'run',
      '-d',
      '--name',
      containerName,
      '--network',
      primaryNetwork,
      '--network-alias',
      row.slug,
      '--restart',
      'unless-stopped',
      '--memory',
      `${Math.max(64, Math.min(2048, row.mem_limit_mb))}m`,
      '--label',
      'sokkan.managed=true',
      '--label',
      `sokkan.service=${row.slug}`,
      '--label',
      `sokkan.template=${row.template_id}`,
      '--label',
      `sokkan.owner=${row.owner_user_id}`,
    ];

    for (const vol of volumes) {
      const safeVolName = `sokkan-svc-${row.slug}-${vol.name}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
      runArgs.push('-v', `${safeVolName}:${vol.mountPath}`);
    }

    if (envEntries.length > 0) {
      runArgs.push('--env-file', envFilePath);
    }

    runArgs.push(row.image, ...cmdArgs);

    await execFileAsync('docker', runArgs, { timeout: 30_000 });

    for (const extraNet of privateNets.slice(1)) {
      await connectContainerToNetwork(containerName, extraNet.docker_name, [row.slug]);
    }

    return {
      executionMode: 'vps',
      status: 'running',
      message: `سرویس ${containerName} با موفقیت روی شبکه ${networkLabel} راه‌اندازی شد.`,
    };
  } catch (err) {
    const errObj = err as { stderr?: string; message?: string };
    const detail = (errObj.stderr || errObj.message || 'خطا در راه‌اندازی سرویس').trim();
    return {
      executionMode: 'vps',
      status: 'error',
      message: detail.slice(0, 600),
    };
  }
}

export async function removeServiceContainer(slug: string): Promise<void> {
  const dockerUp = await isDockerAvailable();
  if (!dockerUp) return;
  const containerName = `sokkan-${slug}`;
  await performContainerAction(containerName, 'remove').catch(() => {});
  const envFilePath = path.join(getDataDir(), 'service-envs', `${slug}.env`);
  if (fs.existsSync(envFilePath)) {
    fs.unlinkSync(envFilePath);
  }
}
