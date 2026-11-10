import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { MetricKey } from './api';

export function metricZoomParam(metric: MetricKey) {
  return `${metric}Zoom`;
}

export function useMetricZoom(metric: MetricKey) {
  const [params, setParams] = useSearchParams();
  const key = metricZoomParam(metric);
  const value = params.get(key);
  const zoom = useMemo(() => {
    const [from, to] = (value ?? '').split(',').map(Number);
    return from > 0 && to > from && Number.isFinite(to) ? { kind: 'fixed' as const, from, to } : undefined;
  }, [value]);

  const setZoom = (nextValue: string | null) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (nextValue === null) next.delete(key);
      else next.set(key, nextValue);
      return next;
    });
  };

  return {
    zoom,
    zoomTo: (from: number, to: number) => setZoom(`${Math.round(from)},${Math.round(to)}`),
    resetZoom: () => setZoom(null),
  };
}
