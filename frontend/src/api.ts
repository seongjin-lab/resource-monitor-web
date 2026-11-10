export type MetricKey = 'cpu' | 'memory' | 'disk' | 'io';
export type ServerStatus = 'connecting' | 'ok' | 'error' | 'disabled';
export type Values = Record<MetricKey, number | null>;

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  fingerprint: string;
  authType: 'password' | 'key';
  enabled: boolean;
  tags: string[];
  status: ServerStatus;
  error: string | null;
  lastUtc: number | null;
  latest: Values | null;
}

export interface Series {
  bucketMs: number;
  t: number[];
  cpu: (number | null)[];
  memory: (number | null)[];
  disk: (number | null)[];
  io: (number | null)[];
}

export interface Settings {
  intervalSeconds: number;
  retentionDays: number;
  cpuWarn: number;
  memoryWarn: number;
  diskWarn: number;
}

export interface ServerInput {
  id?: string;
  name: string;
  host: string;
  port: number;
  user: string;
  authType: 'password' | 'key';
  password?: string;
  privateKey?: string;
  passphrase?: string;
  fingerprint?: string;
  enabled?: boolean;
  tags?: string[];
}

/** 등록된 서버들의 태그를 이름순으로 모은다. */
export function allTags(servers: Server[]): string[] {
  return [...new Set(servers.flatMap((server) => server.tags ?? []))].sort((a, b) => a.localeCompare(b, 'ko'));
}

export interface MetricDef {
  key: MetricKey;
  label: string;
  unit: '%' | 'MB/s';
  max?: number;
  warnKey?: 'cpuWarn' | 'memoryWarn' | 'diskWarn';
}

export const METRICS: MetricDef[] = [
  { key: 'cpu', label: 'CPU', unit: '%', max: 100, warnKey: 'cpuWarn' },
  { key: 'memory', label: '메모리', unit: '%', max: 100, warnKey: 'memoryWarn' },
  { key: 'disk', label: '디스크 용량 (/)', unit: '%', max: 100, warnKey: 'diskWarn' },
  { key: 'io', label: '디스크 입출력', unit: 'MB/s' },
];

export class ApiError extends Error {
  constructor(message: string, public data: Record<string, unknown> = {}) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let data: Record<string, unknown> = {};
    try {
      data = await response.json();
    } catch {
      /* 본문이 JSON이 아니면 상태 코드로 안내한다. */
    }
    throw new ApiError(typeof data.error === 'string' ? data.error : `요청이 실패했습니다. (${response.status})`, data);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  servers: () => request<Server[]>('/api/servers'),
  createServer: (input: ServerInput) => request<Server>('/api/servers', json('POST', input)),
  updateServer: (id: string, input: ServerInput) => request<Server>(`/api/servers/${id}`, json('PUT', input)),
  deleteServer: (id: string) => request<void>(`/api/servers/${id}`, { method: 'DELETE' }),
  setTags: (id: string, tags: string[]) => request<void>(`/api/servers/${id}/tags`, json('PUT', tags)),
  setEnabled: (id: string, enabled: boolean) => request<void>(`/api/servers/${id}/enabled`, json('POST', { enabled })),
  saveOrder: (ids: string[]) => request<void>('/api/servers/order', json('PUT', ids)),
  testServer: (input: ServerInput) =>
    request<{ fingerprint: string; memory: number | null; disk: number | null }>('/api/servers/test', json('POST', input)),
  importRmon: (file: File, password: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('password', password);
    return request<{ added: number; skipped: number }>('/api/servers/import', { method: 'POST', body: form });
  },
  samples: (id: string, from: number, to: number, points = 800) =>
    request<Series>(`/api/servers/${id}/samples?from=${Math.floor(from)}&to=${Math.ceil(to)}&points=${points}`),
  csvUrl: (id: string, from: number, to: number) =>
    `/api/servers/${id}/samples.csv?from=${Math.floor(from)}&to=${Math.ceil(to)}`,
  recent: (minutes: number, points: number) =>
    request<Record<string, Series>>(`/api/samples/recent?minutes=${minutes}&points=${points}`),
  settings: () => request<{ current: Settings; intervalChoices: number[] }>('/api/settings'),
  saveSettings: (settings: Settings) => request<Settings>('/api/settings', json('PUT', settings)),
};

export function formatValue(value: number | null | undefined, unit: string): string {
  if (value == null || Number.isNaN(value)) return '–';
  if (unit === '%') return `${value.toFixed(1)}%`;
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

export function criticalThreshold(warn: number): number {
  return Math.min(100, warn + (100 - warn) / 2);
}

export function warnLevel(metric: MetricDef, value: number | null | undefined, settings: Settings | null):
  'normal' | 'warn' | 'critical' {
  if (value == null || !metric.warnKey || !settings) return 'normal';
  const warn = settings[metric.warnKey];
  if (value >= criticalThreshold(warn)) return 'critical';
  return value >= warn ? 'warn' : 'normal';
}
