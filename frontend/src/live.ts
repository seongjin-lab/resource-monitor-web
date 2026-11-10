import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api, Series, Server, Settings } from './api';
import { RangeSpec, resolveRange } from './range';

export interface SampleEvent {
  serverId: string;
  t: number;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  io: number | null;
}

interface LiveSnapshot {
  servers: Server[];
  loaded: boolean;
  settings: Settings | null;
  intervalChoices: number[];
  connected: boolean;
}

let snapshot: LiveSnapshot = { servers: [], loaded: false, settings: null, intervalChoices: [], connected: false };
const listeners = new Set<() => void>();
const sampleListeners = new Set<(sample: SampleEvent) => void>();

function update(patch: Partial<LiveSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
}

function patchServer(id: string, patch: (server: Server) => Server) {
  update({ servers: snapshot.servers.map((server) => (server.id === id ? patch(server) : server)) });
}

export async function refreshServers() {
  try {
    update({ servers: await api.servers(), loaded: true });
  } catch {
    /* 연결이 돌아오면 다시 불러온다. */
  }
}

export async function refreshSettings() {
  try {
    const result = await api.settings();
    update({ settings: result.current, intervalChoices: result.intervalChoices });
  } catch {
    /* 연결이 돌아오면 다시 불러온다. */
  }
}

export async function saveSettings(settings: Settings) {
  const previous = snapshot.settings;
  const saved = await api.saveSettings(settings);
  if (snapshot.settings === previous) update({ settings: saved });
}

let started = false;

/** 서버 목록·상태·설정을 한 번 불러오고 SSE로 계속 갱신한다. */
export function startLive() {
  if (started) return;
  started = true;
  const source = new EventSource('/api/events');
  source.onopen = () => {
    update({ connected: true });
    refreshServers();
    refreshSettings();
  };
  source.onerror = () => update({ connected: false });
  source.addEventListener('servers', () => refreshServers());
  source.addEventListener('settings', (event) => update({ settings: JSON.parse((event as MessageEvent).data) }));
  source.addEventListener('status', (event) => {
    const data = JSON.parse((event as MessageEvent).data);
    patchServer(data.serverId, (server) => ({
      ...server,
      status: server.enabled ? data.state : 'disabled',
      error: data.error,
      lastUtc: data.lastUtc ?? server.lastUtc,
    }));
  });
  source.addEventListener('sample', (event) => {
    const sample: SampleEvent = JSON.parse((event as MessageEvent).data);
    patchServer(sample.serverId, (server) => ({
      ...server,
      status: 'ok',
      error: null,
      lastUtc: sample.t * 1000,
      latest: { cpu: sample.cpu, memory: sample.memory, disk: sample.disk, io: sample.io },
    }));
    sampleListeners.forEach((listener) => listener(sample));
  });
}

export function useLive(): LiveSnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

export function onSample(listener: (sample: SampleEvent) => void): () => void {
  sampleListeners.add(listener);
  return () => sampleListeners.delete(listener);
}

/** 시계열 끝에 실시간 값을 붙이고 창 밖으로 밀려난 앞부분을 잘라 낸다. */
export function appendSample(series: Series, sample: SampleEvent, windowSeconds: number): Series {
  if (series.t.length > 0 && sample.t <= series.t[series.t.length - 1]) return series;
  const cutoff = sample.t - windowSeconds;
  let start = 0;
  while (start < series.t.length && series.t[start] < cutoff) start++;
  return {
    bucketMs: series.bucketMs,
    t: [...series.t.slice(start), sample.t],
    cpu: [...series.cpu.slice(start), sample.cpu],
    memory: [...series.memory.slice(start), sample.memory],
    disk: [...series.disk.slice(start), sample.disk],
    io: [...series.io.slice(start), sample.io],
  };
}

/**
 * 서버 하나의 시계열을 불러온다. 최근 N분(1시간 이하)은 SSE로 실시간 이어 붙이고,
 * 더 긴 최근 범위는 1분마다 다시 불러오며, 고정 범위는 한 번만 불러온다.
 */
export function useSeries(serverId: string | undefined, range: RangeSpec, points = 800) {
  const request = useMemo(() => ({ serverId, range, points }), [serverId, range, points]);
  const [result, setResult] = useState<{
    request: typeof request;
    data: Series | null;
    bounds: ReturnType<typeof resolveRange> | null;
    error: string | null;
  }>();

  useEffect(() => {
    const { serverId, range, points } = request;
    if (!serverId) return;
    let cancelled = false;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      const bounds = resolveRange(range);
      try {
        const data = await api.samples(serverId, bounds.from, bounds.to, points);
        if (!cancelled) setResult({ request, data, bounds, error: null });
      } catch (reason) {
        if (!cancelled) {
          const error = (reason as Error).message;
          setResult((current) => current?.request === request
            ? { ...current, error }
            : { request, data: null, bounds: null, error });
        }
      } finally {
        pending = false;
      }
    };
    load();

    let unsubscribe = () => {};
    let timer: number | undefined;
    if (range.kind === 'relative') {
      if (range.minutes <= 60) {
        const windowSeconds = range.minutes * 60;
        unsubscribe = onSample((sample) => {
          if (sample.serverId !== serverId) return;
          setResult((current) => {
            if (current?.request !== request || !current.data || !current.bounds) return current;
            const data = appendSample(current.data, sample, windowSeconds);
            if (data === current.data) return current;
            const to = Math.max(current.bounds.to, sample.t * 1000);
            return { ...current, data, bounds: { from: to - windowSeconds * 1000, to } };
          });
        });
      } else {
        timer = window.setInterval(load, 60_000);
      }
    }
    return () => {
      cancelled = true;
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [request]);

  const current = result?.request === request ? result : undefined;
  return {
    data: current?.data,
    bounds: current?.bounds,
    error: current?.error,
    loading: Boolean(serverId && !current),
  };
}
