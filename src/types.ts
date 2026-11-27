export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
}

export interface AuthStatus {
  authenticated: boolean;
  needsSetup: boolean;
  envPasscodeActive: boolean;
  caddyUser?: string;
  user?: AuthUser;
}

export interface NetworkRef {
  id: string;
  name: string;
  slug: string;
  dockerName: string;
  internalOnly: boolean;
}

export interface PanelUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  isActive: boolean;
  networksCount: number;
  projectsCount: number;
  servicesCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PrivateNetworkProjectMember {
  id: string;
  name: string;
  slug: string;
  containerName: string;
  containerPort: number;
  domain: string;
  caddyEnabled: boolean;
  status: string;
  internalHost: string;
  aliasHost: string;
  ipv4Address: string | null;
  isPrimaryNetwork: boolean;
}

export interface PrivateNetworkServiceMember {
  id: string;
  templateId: string;
  name: string;
  slug: string;
  category: 'database' | 'app' | 'tool';
  containerName: string;
  containerPort: number;
  domain: string;
  caddyEnabled: boolean;
  status: string;
  internalHost: string;
  aliasHost: string;
  connectionUrl: string;
  ipv4Address: string | null;
  isPrimaryNetwork: boolean;
}

export interface PrivateNetwork {
  id: string;
  name: string;
  slug: string;
  dockerName: string;
  ownerUserId: string;
  ownerUsername: string;
  ownerDisplayName: string;
  description: string;
  subnet: string;
  internalOnly: boolean;
  dockerExists: boolean;
  dockerContainerCount: number;
  projects: PrivateNetworkProjectMember[];
  services: PrivateNetworkServiceMember[];
  createdAt: string;
  updatedAt: string;
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

export interface AppVersionInfo {
  version: string;
  commitSha: string | null;
  repo: string;
  branch: string;
}

export interface UpdateCheckResult {
  status: 'up_to_date' | 'update_available' | 'ahead' | 'error';
  checkedAt: string;
  repo: string;
  branch: string;
  currentVersion: string;
  currentCommit: string | null;
  latestVersion: string | null;
  latestReleaseTag: string | null;
  latestReleaseUrl: string | null;
  latestReleaseNotes: string | null;
  latestCommit: {
    sha: string;
    shortSha: string;
    message: string;
    author: string;
    date: string;
    url: string;
  } | null;
  commitsBehind: number | null;
  summary: string;
  updateCommand: string;
  fallbackUpdateCommand: string;
  error?: string;
}

export interface SystemStatus {
  executionMode: 'vps' | 'sandbox';
  appVersion?: AppVersionInfo;
  capabilities: {
    dockerAvailable: boolean;
    gitAvailable: boolean;
    caddyReachable: boolean;
    caddyMode: 'admin_api' | 'docker_exec' | 'cli' | 'none';
  };
  counts: {
    projects: number;
    services?: number;
    networks?: number;
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
  ownerUserId?: string;
  privateNetworkId?: string | null;
  networks?: NetworkRef[];
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
  ownerUserId?: string;
}

export interface CaddyRouteItem {
  projectId: string;
  sourceType?: 'project' | 'service';
  name: string;
  slug: string;
  domain: string;
  upstream: string;
  containerPort: number;
  caddyEnabled: boolean;
  caddyExtraDirectives: string;
}

export interface DockerDiskCategory {
  type: string;
  totalCount: string;
  active: string;
  size: string;
  reclaimable: string;
}

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
  category: 'database' | 'app' | 'tool';
  image: string;
  defaultSlug: string;
  containerPort: number;
  supportsDomain: boolean;
  defaultMemLimitMb: number;
  volumes: Array<{ name: string; mountPath: string }>;
  envFields: TemplateEnvField[];
}

export interface DeployedService {
  id: string;
  templateId: string;
  name: string;
  slug: string;
  containerName: string;
  image: string;
  category: 'database' | 'app' | 'tool';
  containerPort: number;
  domain: string;
  caddyEnabled: boolean;
  memLimitMb: number;
  envKeys: string[];
  internalHost: string;
  connectionUrl: string;
  status: string;
  lastMessage: string;
  ownerUserId?: string;
  privateNetworkId?: string | null;
  networks?: NetworkRef[];
  createdAt: string;
  updatedAt: string;
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

export type NavTab =
  | 'overview'
  | 'networks'
  | 'projects'
  | 'templates'
  | 'containers'
  | 'caddy'
  | 'provisioning'
  | 'users';
