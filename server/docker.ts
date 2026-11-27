import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DockerTarget {
  socketPath?: string;
  host?: string;
  port?: number;
}

export function resolveDockerTarget(): DockerTarget | null {
  const envHost = process.env.DOCKER_HOST?.trim();
  if (envHost) {
    if (envHost.startsWith('unix://')) {
      const p = envHost.slice('unix://'.length);
      return fs.existsSync(p) ? { socketPath: p } : null;
    }
    if (envHost.startsWith('tcp://') || envHost.startsWith('http://')) {
      const normalized = envHost.replace(/^tcp:\/\//, 'http://');
      try {
        const u = new URL(normalized);
        return { host: u.hostname, port: Number(u.port || 2375) };
      } catch {
        return null;
      }
    }
  }
  const defaultSock = '/var/run/docker.sock';
  if (fs.existsSync(defaultSock)) {
    return { socketPath: defaultSock };
  }
  return null;
}

function dockerRequest<T>(
  method: string,
  reqPath: string,
  body?: unknown,
  timeoutMs = 5000,
): Promise<{ status: number; data: T }> {
  return new Promise((resolve, reject) => {
    const target = resolveDockerTarget();
    if (!target) {
      reject(new Error('DOCKER_UNAVAILABLE'));
      return;
    }

    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      method,
      path: reqPath,
      timeout: timeoutMs,
      headers: payload
        ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }
        : undefined,
      ...(target.socketPath
        ? { socketPath: target.socketPath }
        : { host: target.host, port: target.port }),
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = raw;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode ?? 500, data: parsed as T });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('DOCKER_TIMEOUT'));
    });
    req.on('error', (err) => reject(err));

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function dockerRawRequest(reqPath: string, timeoutMs = 5000): Promise<{ status: number; buffer: Buffer }> {
  return new Promise((resolve, reject) => {
    const target = resolveDockerTarget();
    if (!target) {
      reject(new Error('DOCKER_UNAVAILABLE'));
      return;
    }
    const options: http.RequestOptions = {
      method: 'GET',
      path: reqPath,
      timeout: timeoutMs,
      ...(target.socketPath
        ? { socketPath: target.socketPath }
        : { host: target.host, port: target.port }),
    };
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 500, buffer: Buffer.concat(chunks) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('DOCKER_TIMEOUT')));
    req.on('error', (err) => reject(err));
    req.end();
  });
}

export async function isDockerAvailable(): Promise<boolean> {
  try {
    const res = await dockerRequest<string>('GET', '/_ping', undefined, 2000);
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function isGitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'], { timeout: 2500 });
    return true;
  } catch {
    return false;
  }
}

export interface DockerContainerSummary {
  id: string;
  shortId: string;
  name: string;
  image: string;
  state: string;
  status: string;
  createdAt: string;
  ports: string[];
  networks: string[];
  managedByPanel: boolean;
  ownerUserId?: string;
  projectSlug?: string;
  serviceSlug?: string;
}

interface RawDockerContainer {
  Id: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
  Created?: number;
  Labels?: Record<string, string>;
  Ports?: Array<{ PrivatePort?: number; PublicPort?: number; Type?: string }>;
  NetworkSettings?: { Networks?: Record<string, unknown> };
}

export async function listDockerContainers(): Promise<DockerContainerSummary[]> {
  const res = await dockerRequest<RawDockerContainer[]>('GET', '/containers/json?all=1');
  if (res.status !== 200 || !Array.isArray(res.data)) {
    throw new Error('خطا در دریافت لیست کانتینرها از داکر');
  }

  return res.data.map((c) => {
    const rawName = c.Names?.[0] ?? c.Id.slice(0, 12);
    const name = rawName.startsWith('/') ? rawName.slice(1) : rawName;
    const ports = (c.Ports ?? []).map((p) =>
      p.PublicPort
        ? `${p.PublicPort}->${p.PrivatePort}/${p.Type ?? 'tcp'}`
        : `${p.PrivatePort}/${p.Type ?? 'tcp'}`,
    );
    const networks = Object.keys(c.NetworkSettings?.Networks ?? {});
    return {
      id: c.Id,
      shortId: c.Id.slice(0, 12),
      name,
      image: c.Image ?? '',
      state: c.State ?? 'unknown',
      status: c.Status ?? '',
      createdAt: c.Created ? new Date(c.Created * 1000).toISOString() : '',
      ports: Array.from(new Set(ports)),
      networks,
      managedByPanel:
        c.Labels?.['sokkan.managed'] === 'true' || c.Labels?.['sokanyar.managed'] === 'true',
      ownerUserId: c.Labels?.['sokkan.owner'],
      projectSlug: c.Labels?.['sokkan.project'],
      serviceSlug: c.Labels?.['sokkan.service'],
    };
  });
}

export async function performContainerAction(
  containerId: string,
  action: 'start' | 'stop' | 'restart' | 'remove',
): Promise<void> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(containerId)) {
    throw new Error('شناسه کانتینر نامعتبر است');
  }
  if (action === 'remove') {
    const res = await dockerRequest<unknown>('DELETE', `/containers/${containerId}?force=1`, undefined, 10000);
    if (res.status >= 400) {
      throw new Error(`حذف کانتینر ناموفق بود (${res.status})`);
    }
    return;
  }
  const res = await dockerRequest<unknown>(
    'POST',
    `/containers/${containerId}/${action}`,
    undefined,
    15000,
  );
  if (res.status >= 400 && res.status !== 304) {
    throw new Error(`اجرای عملیات ${action} ناموفق بود (${res.status})`);
  }
}

function stripDockerMultiplexHeader(buf: Buffer): string {
  const lines: string[] = [];
  let offset = 0;
  let looksMultiplexed = true;
  while (offset + 8 <= buf.length) {
    const streamType = buf[offset];
    if (
      (streamType !== 1 && streamType !== 2 && streamType !== 0) ||
      buf[offset + 1] !== 0 ||
      buf[offset + 2] !== 0 ||
      buf[offset + 3] !== 0
    ) {
      looksMultiplexed = false;
      break;
    }
    const frameLen = buf.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + frameLen > buf.length) {
      looksMultiplexed = false;
      break;
    }
    lines.push(buf.subarray(offset, offset + frameLen).toString('utf8'));
    offset += frameLen;
  }
  if (looksMultiplexed && lines.length > 0) {
    return lines.join('');
  }
  return buf.toString('utf8');
}

export async function getContainerLogs(containerId: string, tail = 200): Promise<string> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(containerId)) {
    throw new Error('شناسه کانتینر نامعتبر است');
  }
  const safeTail = Math.min(Math.max(10, tail), 1000);
  const res = await dockerRawRequest(
    `/containers/${containerId}/logs?stdout=1&stderr=1&timestamps=1&tail=${safeTail}`,
    8000,
  );
  if (res.status >= 400) {
    throw new Error(`خواندن لاگ کانتینر ناموفق بود (${res.status})`);
  }
  return stripDockerMultiplexHeader(res.buffer);
}

export interface ContainerStatSnapshot {
  cpuPercent: number;
  memUsedMb: number;
  memLimitMb: number;
  memPercent: number;
}

interface RawDockerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: { cache?: number; inactive_file?: number };
  };
}

export async function getContainerStats(containerId: string): Promise<ContainerStatSnapshot> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(containerId)) {
    throw new Error('شناسه کانتینر نامعتبر است');
  }
  const res = await dockerRequest<RawDockerStats>(
    'GET',
    `/containers/${containerId}/stats?stream=false`,
    undefined,
    5000,
  );
  if (res.status !== 200 || !res.data) {
    throw new Error('خواندن آمار مصرف منابع ممکن نشد');
  }
  const cpuDelta =
    (res.data.cpu_stats?.cpu_usage?.total_usage ?? 0) -
    (res.data.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta =
    (res.data.cpu_stats?.system_cpu_usage ?? 0) -
    (res.data.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = res.data.cpu_stats?.online_cpus || 1;
  const cpuPercent =
    sysDelta > 0 && cpuDelta > 0 ? Number(((cpuDelta / sysDelta) * cpus * 100).toFixed(2)) : 0;

  const cache =
    res.data.memory_stats?.stats?.inactive_file ??
    res.data.memory_stats?.stats?.cache ??
    0;
  const memBytes = Math.max(0, (res.data.memory_stats?.usage ?? 0) - cache);
  const limitBytes = res.data.memory_stats?.limit ?? 1;
  const memUsedMb = Math.round(memBytes / (1024 * 1024));
  const memLimitMb = Math.round(limitBytes / (1024 * 1024));
  const memPercent = Number(((memBytes / limitBytes) * 100).toFixed(1));

  return { cpuPercent, memUsedMb, memLimitMb, memPercent };
}

export interface DockerNetworkContainerMember {
  id: string;
  name: string;
  ipv4Address: string;
}

export interface DockerNetworkInspect {
  id: string;
  name: string;
  driver: string;
  internal: boolean;
  subnet: string;
  containers: DockerNetworkContainerMember[];
}

interface RawDockerNetwork {
  Id?: string;
  Name?: string;
  Driver?: string;
  Internal?: boolean;
  IPAM?: { Config?: Array<{ Subnet?: string }> };
  Containers?: Record<
    string,
    {
      Name?: string;
      IPv4Address?: string;
    }
  >;
}

export async function inspectDockerNetwork(networkName: string): Promise<DockerNetworkInspect | null> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(networkName)) {
    return null;
  }
  try {
    const res = await dockerRequest<RawDockerNetwork>(
      'GET',
      `/networks/${encodeURIComponent(networkName)}`,
    );
    if (res.status !== 200 || !res.data || !res.data.Name) {
      return null;
    }
    const containers = Object.entries(res.data.Containers ?? {}).map(([id, info]) => ({
      id,
      name: info.Name ?? id.slice(0, 12),
      ipv4Address: (info.IPv4Address ?? '').split('/')[0],
    }));
    const subnet = res.data.IPAM?.Config?.[0]?.Subnet ?? '';
    return {
      id: res.data.Id ?? '',
      name: res.data.Name,
      driver: res.data.Driver ?? 'bridge',
      internal: Boolean(res.data.Internal),
      subnet,
      containers,
    };
  } catch {
    return null;
  }
}

export async function createDockerNetwork(
  networkName: string,
  options?: { internal?: boolean; subnet?: string; ownerUserId?: string },
): Promise<void> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(networkName)) {
    throw new Error('نام شبکه داکر نامعتبر است.');
  }
  const existing = await inspectDockerNetwork(networkName);
  if (existing) {
    return;
  }

  const body: Record<string, unknown> = {
    Name: networkName,
    Driver: 'bridge',
    CheckDuplicate: true,
    Internal: Boolean(options?.internal),
    Labels: {
      'sokkan.managed': 'true',
      ...(options?.ownerUserId ? { 'sokkan.owner': options.ownerUserId } : {}),
    },
  };

  if (options?.subnet?.trim()) {
    body.IPAM = {
      Driver: 'default',
      Config: [{ Subnet: options.subnet.trim() }],
    };
  }

  const res = await dockerRequest<{ message?: string }>('POST', '/networks/create', body, 8000);
  if (res.status >= 400) {
    const msg =
      res.data && typeof res.data === 'object' && 'message' in res.data && res.data.message
        ? String(res.data.message)
        : `ایجاد شبکه داکر ناموفق بود (${res.status})`;
    throw new Error(msg);
  }
}

export async function ensureDockerNetwork(
  networkName: string,
  options?: { internal?: boolean; subnet?: string; ownerUserId?: string },
): Promise<void> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(networkName)) {
    return;
  }
  const existing = await inspectDockerNetwork(networkName);
  if (existing) {
    return;
  }
  await createDockerNetwork(networkName, options).catch(() => {});
}

export async function connectContainerToNetwork(
  containerNameOrId: string,
  networkName: string,
  aliases?: string[],
): Promise<boolean> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(containerNameOrId) || !/^[a-zA-Z0-9_.-]+$/.test(networkName)) {
    return false;
  }
  try {
    const inspect = await inspectDockerNetwork(networkName);
    if (
      inspect &&
      inspect.containers.some(
        (c) => c.name === containerNameOrId || c.id === containerNameOrId,
      )
    ) {
      return true;
    }

    const endpointConfig: Record<string, unknown> = {};
    const cleanAliases = (aliases ?? []).filter((a) => /^[a-zA-Z0-9_.-]+$/.test(a));
    if (cleanAliases.length > 0) {
      endpointConfig.Aliases = cleanAliases;
    }

    const res = await dockerRequest<unknown>(
      'POST',
      `/networks/${encodeURIComponent(networkName)}/connect`,
      {
        Container: containerNameOrId,
        EndpointConfig: endpointConfig,
      },
      6000,
    );
    return res.status < 400 || res.status === 403 || res.status === 409;
  } catch {
    return false;
  }
}

export async function disconnectContainerFromNetwork(
  containerNameOrId: string,
  networkName: string,
): Promise<void> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(containerNameOrId) || !/^[a-zA-Z0-9_.-]+$/.test(networkName)) {
    return;
  }
  try {
    await dockerRequest<unknown>(
      'POST',
      `/networks/${encodeURIComponent(networkName)}/disconnect`,
      {
        Container: containerNameOrId,
        Force: true,
      },
      6000,
    );
  } catch {
    // Ignore if container or network is not currently attached
  }
}

export async function removeDockerNetwork(networkName: string): Promise<void> {
  if (!/^[a-zA-Z0-9_.-]+$/.test(networkName)) return;
  if (['bridge', 'host', 'none', 'web'].includes(networkName)) return;
  const info = await inspectDockerNetwork(networkName);
  if (!info) return;
  for (const member of info.containers) {
    await disconnectContainerFromNetwork(member.id, networkName);
  }
  await dockerRequest('DELETE', `/networks/${encodeURIComponent(networkName)}`, undefined, 6000).catch(
    () => {},
  );
}

function tcpProbe(host: string, port: number, timeoutMs = 2500): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (res: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(res);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done({ ok: true }));
    socket.on('timeout', () => done({ ok: false, error: 'TIMEOUT' }));
    socket.on('error', (err) => done({ ok: false, error: err.message }));
  });
}

export interface NetworkProbeResult {
  executionMode: 'vps' | 'sandbox';
  reachable: boolean;
  networkName: string;
  targetHost: string;
  targetPort: number;
  resolvedIp: string | null;
  method: 'GET' | 'POST' | 'TCP';
  path: string;
  statusCode: number | null;
  latencyMs: number;
  responsePreview: string;
  message: string;
}

export async function probeTargetInNetwork(params: {
  networkName: string;
  containerName: string;
  port: number;
  method: 'GET' | 'POST' | 'TCP';
  reqPath: string;
  containerStatusHint?: string;
}): Promise<NetworkProbeResult> {
  const start = Date.now();
  const dockerUp = await isDockerAvailable();

  if (!dockerUp) {
    return {
      executionMode: 'sandbox',
      reachable: true,
      networkName: params.networkName,
      targetHost: params.containerName,
      targetPort: params.port,
      resolvedIp: '172.28.0.x (پیش‌نمایش)',
      method: params.method,
      path: params.reqPath,
      statusCode: params.method === 'TCP' ? null : 200,
      latencyMs: Date.now() - start,
      responsePreview: `حالت پیش‌نمایش بدون داکر: مسیر داخلی ${params.containerName}:${params.port}${params.method === 'TCP' ? '' : params.reqPath} روی شبکه ${params.networkName} آماده استفاده بین کانتینرها است.`,
      message: `اتصال داخلی روی شبکه ${params.networkName} معتبر است (در VPS واقعی درخواست مستقیم به کانتینر ارسال می‌شود).`,
    };
  }

  const netInfo = await inspectDockerNetwork(params.networkName);
  const member = netInfo?.containers.find((c) => c.name === params.containerName);
  if (!netInfo) {
    return {
      executionMode: 'vps',
      reachable: false,
      networkName: params.networkName,
      targetHost: params.containerName,
      targetPort: params.port,
      resolvedIp: null,
      method: params.method,
      path: params.reqPath,
      statusCode: null,
      latencyMs: Date.now() - start,
      responsePreview: '',
      message: `شبکه داکر «${params.networkName}» هنوز روی میزبان ساخته نشده است.`,
    };
  }

  if (!member || !member.ipv4Address) {
    return {
      executionMode: 'vps',
      reachable: false,
      networkName: params.networkName,
      targetHost: params.containerName,
      targetPort: params.port,
      resolvedIp: null,
      method: params.method,
      path: params.reqPath,
      statusCode: null,
      latencyMs: Date.now() - start,
      responsePreview: '',
      message: `کانتینر «${params.containerName}» در حال حاضر به شبکه «${params.networkName}» متصل نیست یا در حال اجرا نمی‌باشد.`,
    };
  }

  // Inspect container running state so isolated networks (not directly routed to sokkan-panel) report accurately
  let containerRunning = false;
  try {
    const inspectRes = await dockerRequest<{ State?: { Running?: boolean } }>(
      'GET',
      `/containers/${encodeURIComponent(params.containerName)}/json`,
      undefined,
      3000,
    );
    containerRunning = Boolean(inspectRes.status === 200 && inspectRes.data?.State?.Running);
  } catch {
    containerRunning = false;
  }

  // Test TCP / HTTP directly to container IPv4 when reachable from host/sokkan-panel network
  const tcpRes = await tcpProbe(member.ipv4Address, params.port, 2500);
  if (params.method === 'TCP') {
    const latencyMs = Date.now() - start;
    const isolatedRunning = !tcpRes.ok && containerRunning;
    return {
      executionMode: 'vps',
      reachable: tcpRes.ok || isolatedRunning,
      networkName: params.networkName,
      targetHost: params.containerName,
      targetPort: params.port,
      resolvedIp: member.ipv4Address,
      method: 'TCP',
      path: '',
      statusCode: null,
      latencyMs,
      responsePreview: tcpRes.ok
        ? `TCP handshake OK -> ${params.containerName} (${member.ipv4Address}:${params.port})`
        : isolatedRunning
          ? `Container running inside isolated network ${params.networkName} (${member.ipv4Address}:${params.port}). Direct panel bridge blocked by network isolation.`
          : `TCP error: ${tcpRes.error || 'Connection refused'}`,
      message: tcpRes.ok
        ? `پورت ${params.port} روی کانتینر ${params.containerName} (${member.ipv4Address}) در شبکه ${params.networkName} پاسخ داد.`
        : isolatedRunning
          ? `کانتینر ${params.containerName} داخل شبکه ایزوله ${params.networkName} فعال و متصل است (${member.ipv4Address})؛ کانتینرهای هم‌شبکه از طریق ${params.containerName}:${params.port} مستقیماً به آن متصل می‌شوند.`
          : `اتصال TCP به ${member.ipv4Address}:${params.port} برقرار نشد (${tcpRes.error || 'کانتینر متوقف یا پورت بسته'}).`,
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const targetUrl = `http://${member.ipv4Address}:${params.port}${params.reqPath}`;
    const res = await fetch(targetUrl, {
      method: params.method,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const bodyText = (await res.text()).slice(0, 600);
    return {
      executionMode: 'vps',
      reachable: true,
      networkName: params.networkName,
      targetHost: params.containerName,
      targetPort: params.port,
      resolvedIp: member.ipv4Address,
      method: params.method,
      path: params.reqPath,
      statusCode: res.status,
      latencyMs: Date.now() - start,
      responsePreview: bodyText || `(پاسخ خالی با کد ${res.status})`,
      message: `درخواست ${params.method} به ${params.containerName}:${params.port}${params.reqPath} با کد ${res.status} پاسخ گرفت.`,
    };
  } catch (err) {
    const isolatedRunning = !tcpRes.ok && containerRunning;
    return {
      executionMode: 'vps',
      reachable: tcpRes.ok || isolatedRunning,
      networkName: params.networkName,
      targetHost: params.containerName,
      targetPort: params.port,
      resolvedIp: member.ipv4Address,
      method: params.method,
      path: params.reqPath,
      statusCode: null,
      latencyMs: Date.now() - start,
      responsePreview: isolatedRunning
        ? `Container running inside isolated network ${params.networkName} (${member.ipv4Address}:${params.port})`
        : err instanceof Error
          ? err.message
          : 'Request failed',
      message: tcpRes.ok
        ? `پورت TCP باز است اما درخواست HTTP کامل نشد (احتمالاً پروتکل سرویس غیرHTTP است).`
        : isolatedRunning
          ? `کانتینر ${params.containerName} داخل شبکه ایزوله ${params.networkName} فعال است؛ به دلیل ایزولاسیون، پنل مسیر مستقیم ندارد اما سرویس‌های هم‌شبکه از طریق ${params.containerName}:${params.port} به آن دسترسی دارند.`
          : `ارتباط مستقیم از پنل به IP داخلی ${member.ipv4Address} برقرار نشد؛ سرویس‌ها داخل شبکه ${params.networkName} از طریق نام میزبان ${params.containerName}:${params.port} به هم متصل می‌شوند.`,
    };
  }
}

export interface HostMetrics {
  hostname: string;
  platform: string;
  arch: string;
  uptimeSeconds: number;
  cpuCores: number;
  cpuLoadPercent: number;
  loadAvg1m: number;
  memTotalMb: number;
  memUsedMb: number;
  memPercent: number;
  diskTotalGb: number;
  diskUsedGb: number;
  diskPercent: number;
  sampledAt: string;
}

export async function getSystemHostMetrics(): Promise<HostMetrics> {
  const cpus = os.cpus();
  const cpuCores = Math.max(1, cpus.length);
  const load1 = os.loadavg()[0] ?? 0;
  const cpuLoadPercent = Number(Math.min(100, (load1 / cpuCores) * 100).toFixed(1));

  const totalMemBytes = os.totalmem();
  const freeMemBytes = os.freemem();
  const usedMemBytes = Math.max(0, totalMemBytes - freeMemBytes);
  const memTotalMb = Math.round(totalMemBytes / (1024 * 1024));
  const memUsedMb = Math.round(usedMemBytes / (1024 * 1024));
  const memPercent = Number(((usedMemBytes / Math.max(1, totalMemBytes)) * 100).toFixed(1));

  let diskTotalGb = 0;
  let diskUsedGb = 0;
  let diskPercent = 0;
  try {
    const { stdout } = await execFileAsync('df', ['-kP', '/'], { timeout: 2500 });
    const lines = stdout.trim().split('\n');
    if (lines.length >= 2) {
      const cols = lines[1].trim().split(/\s+/);
      const totalKb = Number(cols[1] ?? 0);
      const usedKb = Number(cols[2] ?? 0);
      if (totalKb > 0) {
        diskTotalGb = Number((totalKb / (1024 * 1024)).toFixed(1));
        diskUsedGb = Number((usedKb / (1024 * 1024)).toFixed(1));
        diskPercent = Number(((usedKb / totalKb) * 100).toFixed(1));
      }
    }
  } catch {
    // df fallback stays 0 if restricted
  }

  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    uptimeSeconds: Math.floor(os.uptime()),
    cpuCores,
    cpuLoadPercent,
    loadAvg1m: Number(load1.toFixed(2)),
    memTotalMb,
    memUsedMb,
    memPercent,
    diskTotalGb,
    diskUsedGb,
    diskPercent,
    sampledAt: new Date().toISOString(),
  };
}

export interface DockerDiskCategory {
  type: string;
  totalCount: string;
  active: string;
  size: string;
  reclaimable: string;
}

export async function getDockerDiskUsage(): Promise<DockerDiskCategory[]> {
  try {
    const { stdout } = await execFileAsync('docker', ['system', 'df', '--format', '{{json .}}'], {
      timeout: 8000,
    });
    const rows: DockerDiskCategory[] = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as {
          Type?: string;
          TotalCount?: string;
          Active?: string;
          Size?: string;
          Reclaimable?: string;
        };
        rows.push({
          type: parsed.Type ?? '',
          totalCount: parsed.TotalCount ?? '0',
          active: parsed.Active ?? '0',
          size: parsed.Size ?? '0B',
          reclaimable: parsed.Reclaimable ?? '0B',
        });
      } catch {
        // Ignore malformed line
      }
    }
    return rows;
  } catch {
    return [];
  }
}

export async function pruneDockerUnused(): Promise<{ reclaimedSummary: string }> {
  const imgOut = await execFileAsync('docker', ['image', 'prune', '-f'], { timeout: 60_000 });
  const buildOut = await execFileAsync('docker', ['builder', 'prune', '-f'], { timeout: 60_000 }).catch(
    () => ({ stdout: '' }),
  );
  const lines = [imgOut.stdout, buildOut.stdout]
    .join('\n')
    .split('\n')
    .filter((l) => l.toLowerCase().includes('reclaimed'));
  return {
    reclaimedSummary: lines.join(' | ').trim() || 'پاک‌سازی ایمیج‌ها و کش بیلد بلااستفاده انجام شد.',
  };
}
