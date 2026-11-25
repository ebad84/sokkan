export interface AuthStatus {
  authenticated: boolean;
  needsSetup: boolean;
  envPasscodeActive: boolean;
  caddyUser?: string;
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

export interface MetricSample {
  cpu_percent: number;
  mem_percent: number;
  disk_percent: number;
  sampled_at: string;
}

export interface BeszelSystemSummary {
  id: string;
  name: string;
  host: string;
  status: string;
  cpu: number;
  memPercent: number;
  diskPercent: number;
  uptime: number;
  updated: string;
}

export interface BeszelStatPoint {
  created: string;
  cpu: number;
  memPercent: number;
  diskPercent: number;
  netSentMb: number;
  netRecvMb: number;
}

export interface BeszelTelemetry {
  connected: boolean;
  error?: string;
  systems: BeszelSystemSummary[];
  history: BeszelStatPoint[];
}

export interface SystemStatus {
  executionMode: 'vps' | 'sandbox';
  capabilities: {
    dockerAvailable: boolean;
    gitAvailable: boolean;
    caddyReachable: boolean;
    caddyMode: 'admin_api' | 'docker_exec' | 'cli' | 'none';
  };
  counts: {
    projects: number;
    deployments: number;
  };
  hostMetrics: HostMetrics;
  recentSamples: MetricSample[];
  beszel: BeszelTelemetry;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  repoUrl: string;
  branch: string;
  buildMode: 'dockerfile' | 'compose';
  buildFilePath: string;
  dockerfileContext: string;
  containerPort: number;
  domain: string;
  caddyEnabled: boolean;
  caddyExtraDirectives: string;
  autoDeployWebhook: boolean;
  pollingIntervalSec: number;
  lastPolledAt: string | null;
  hasGithubToken: boolean;
  githubTokenMasked: string;
  hasWebhookSecret: boolean;
  webhookSecretMasked: string;
  envKeys: string[];
  lastCommitSha: string;
  lastCommitMsg: string;
  lastDeployedAt: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubInspectionResult {
  owner: string;
  repo: string;
  canonicalUrl: string;
  defaultBranch: string;
  isPrivate: boolean;
  description: string;
  latestCommit: {
    sha: string;
    shortSha: string;
    message: string;
    author: string;
    date: string;
  } | null;
  detectedBuildMode: 'dockerfile' | 'compose' | 'unknown';
  detectedBuildFile: string;
  detectedPorts: number[];
  composeServices: Array<{
    name: string;
    ports: number[];
    hasBuild: boolean;
    image?: string;
  }>;
  envExampleKeys: string[];
  rootFiles: string[];
}

export interface Deployment {
  id: string;
  project_id: string;
  trigger_type: 'manual' | 'webhook' | 'polling';
  status: 'building' | 'success' | 'failed';
  commit_sha: string;
  commit_message: string;
  logs: string;
  started_at: string;
  finished_at: string | null;
  execution_mode: 'vps' | 'sandbox';
}

export interface DockerContainer {
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
}

export interface CaddyRouteItem {
  projectId: string;
  name: string;
  slug: string;
  domain: string;
  upstream: string;
  containerPort: number;
  caddyEnabled: boolean;
  caddyExtraDirectives: string;
}

export interface CaddySnapshot {
  id: string;
  content: string;
  note: string;
  applied: number;
  created_at: string;
}

export interface CaddyState {
  content: string;
  managedPreview: string;
  snapshots: CaddySnapshot[];
  caddyStatus: { reachable: boolean; mode: 'admin_api' | 'docker_exec' | 'cli' | 'none' };
  routes: CaddyRouteItem[];
}

export interface BeszelConfig {
  enabled: boolean;
  url: string;
  email: string;
  hasPassword: boolean;
}

export type NavTab = 'overview' | 'projects' | 'containers' | 'caddy' | 'provisioning';
