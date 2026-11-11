import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import uPlot from 'uplot';
import { allTags, api, MetricDef, METRICS, Series } from '../api';
import { Chart, ChartZoomReset } from '../components/Chart';
import { EmptyState, RangePicker, Segmented } from '../components/Common';
import { RefreshInterval } from '../components/RefreshInterval';
import { appendSample, onSample, useLive } from '../live';
import { metricZoomParam, useMetricZoom } from '../metricZoom';
import { describeBucket, describeRange, parseRange, RangeSpec, rangeParams, resolveRange } from '../range';
import { getTagColor, tagColorStyle } from '../tagColors';

const PALETTE = ['#5fd3a8', '#6aa8ff', '#f5b84a', '#ef6f8a', '#c08bff', '#4fd1e0', '#e8e86a', '#ff9a5c'];
const METRIC_OPTIONS = [
  ...METRICS.map(({ key, label }) => ({ value: key, label })),
  { value: 'all' as const, label: '모든 지표' },
];
const SELECTION_STORAGE_KEY = 'compare-selection';
const SELECTION_PARAMS = ['servers', 'tag', 'previousServers'];

function useComparisonSeries(selected: string[], range?: RangeSpec) {
  const key = selected.join(',') + JSON.stringify(range);
  const [result, setResult] = useState<{ key: string; data: Record<string, Series> } | { key: string; error: string }>();

  useEffect(() => {
    if (!range || selected.length === 0) return;
    let cancelled = false;
    const load = () => {
      const { from, to } = resolveRange(range);
      Promise.all(selected.map((id) => api.samples(id, from, to, 600).then((series) => [id, series] as const)))
        .then((entries) => !cancelled && setResult({ key, data: Object.fromEntries(entries) }))
        .catch((error: Error) => {
          if (!cancelled) setResult((current) =>
            current?.key === key && 'data' in current ? current : { key, error: error.message },
          );
        });
    };
    load();
    let unsubscribe = () => {};
    let timer: number | undefined;
    if (range.kind === 'relative') {
      if (range.minutes <= 60) {
        unsubscribe = onSample((sample) => {
          if (!selected.includes(sample.serverId)) return;
          setResult((current) =>
            current?.key === key && 'data' in current && current.data[sample.serverId]
              ? { key, data: { ...current.data, [sample.serverId]: appendSample(current.data[sample.serverId], sample, range.minutes * 60) } }
              : current,
          );
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return result?.key === key ? result : undefined;
}

type ComparisonSource = { id: string; label: string; color: string };

function ComparisonMetricChart({ metric, sources, data, xRange, rangeLabel, bucket, warn, showAll, onSharedZoom }: {
  metric: MetricDef;
  sources: ComparisonSource[];
  data: Record<string, Series>;
  xRange: { from: number; to: number };
  rangeLabel: string;
  bucket?: string | null;
  warn?: number;
  showAll: boolean;
  onSharedZoom: (from: number, to: number) => void;
}) {
  const { zoom: savedZoom, zoomTo, resetZoom } = useMetricZoom(metric.key);
  const zoom = showAll ? savedZoom : undefined;
  const result = useComparisonSeries(sources.map(({ id }) => id), zoom);
  const zoomData = result && 'data' in result ? result.data : undefined;
  const chartData = zoomData ?? data;
  const zoomBucket = zoomData && Object.values(zoomData).map((samples) => describeBucket(samples.bucketMs)).find(Boolean);
  const chartBucket = zoom ? zoomBucket : bucket;
  const { t, series } = useMemo(() => {
    const joined = uPlot.join(sources.map(({ id }) => [chartData[id].t, chartData[id][metric.key]] as uPlot.AlignedData));
    return {
      t: joined[0] as number[],
      series: sources.map(({ label, color }, index) => ({ label, color, values: joined[index + 1] as (number | null)[] })),
    };
  }, [chartData, metric.key, sources]);

  return (
    <section className="panel">
      <div className="row chart-heading">
        <h3>{metric.label}{metric.unit === 'MB/s' ? ` (${metric.unit})` : ''}</h3>
        {warn != null && <span className="hint chart-warning">경고 기준 {warn}%</span>}
        <span className="hint">조회 기간 · {zoom ? describeRange(zoom) : rangeLabel}{chartBucket ? ` · ${chartBucket}` : ''}</span>
        {zoom && !result && <span className="hint" role="status">확대 구간을 불러오는 중…</span>}
        {zoom && <ChartZoomReset label={metric.label} onReset={resetZoom} />}
      </div>
      {result && 'error' in result && <div className="banner error" role="alert">확대 구간 조회 실패 · {result.error}</div>}
      <Chart
        t={t}
        series={series}
        unit={metric.unit}
        max={metric.max}
        warn={warn}
        height={showAll ? undefined : 380}
        spanGaps
        cursorTooltip
        xRange={zoom ?? xRange}
        onZoom={showAll ? zoomTo : onSharedZoom}
      />
    </section>
  );
}

/** 여러 서버의 같은 지표를 한 그래프에 겹쳐 본다. 선택 상태와 범위는 URL에 남아 링크로 공유할 수 있다. */
export default function Compare() {
  const live = useLive();
  const [params, setParams] = useSearchParams();
  const hasSelection = params.has('servers') || params.has('tag');
  const selection = new URLSearchParams([...params].filter(([key]) => SELECTION_PARAMS.includes(key))).toString();
  const range = parseRange(params);
  const metricKey = params.get('metric') ?? 'all';
  const showAll = metricKey === 'all';
  const metric = METRICS.find((item) => item.key === metricKey) ?? METRICS[0];
  const tags = allTags(live.servers);
  const requestedTags = params.getAll('tag');
  const activeTags = tags.filter((tag) => requestedTags.includes(tag));
  const previousServers = params.get('previousServers');
  const serversForTags = (selectedTags: string[]) =>
    live.servers.filter((server) => server.tags.some((tag) => selectedTags.includes(tag))).map((server) => server.id);
  const manualServers = requestedTags.length > 0 ? previousServers : params.get('servers');
  const selected = activeTags.length > 0
    ? serversForTags(activeTags)
    : (manualServers ?? '').split(',').filter((id) => live.servers.some((server) => server.id === id));
  const currentResult = useComparisonSeries(selected, range);
  const data = currentResult && 'data' in currentResult ? currentResult.data : undefined;

  const update = (patch: Record<string, string | string[] | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === 'string') {
        next.set(key, value);
      } else {
        next.delete(key);
        value?.forEach((item) => next.append(key, item));
      }
    }
    setParams(next);
  };
  const setRange = (next: RangeSpec) => {
    const rest = new URLSearchParams(params);
    ['range', 'from', 'to'].forEach((key) => rest.delete(key));
    METRICS.forEach(({ key }) => rest.delete(metricZoomParam(key)));
    Object.entries(rangeParams(next)).forEach(([key, value]) => rest.set(key, value));
    setParams(rest);
  };
  const toggleServer = (id: string) => {
    const servers = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
    update({ tag: null, previousServers: null, servers: servers.join(',') });
  };

  const toggleTag = (tag: string) => {
    const nextTags = activeTags.includes(tag) ? activeTags.filter((item) => item !== tag) : [...activeTags, tag];
    if (nextTags.length === 0) {
      update({ tag: null, previousServers: null, servers: previousServers ?? '' });
      return;
    }
    update({
      tag: nextTags,
      servers: serversForTags(nextTags).join(','),
      previousServers: activeTags.length > 0 ? previousServers : selected.join(','),
    });
  };

  useEffect(() => {
    if (!hasSelection) return;
    try {
      localStorage.setItem(SELECTION_STORAGE_KEY, selection);
    } catch {
      /* 저장소를 사용할 수 없을 때는 URL에 선택 상태가 남는다. */
    }
  }, [hasSelection, selection]);

  useEffect(() => {
    if (hasSelection || !live.loaded || live.servers.length === 0) return;

    let saved = new URLSearchParams();
    try {
      saved = new URLSearchParams(localStorage.getItem(SELECTION_STORAGE_KEY) ?? '');
    } catch {
      /* 저장소를 사용할 수 없을 때는 초기 선택을 사용한다. */
    }
    if (!saved.has('servers') && !saved.has('tag')) {
      const defaults = live.servers.filter((server) => server.enabled).slice(0, 4).map((server) => server.id);
      saved = new URLSearchParams({ servers: defaults.join(',') });
    }
    const next = new URLSearchParams(params);
    for (const key of SELECTION_PARAMS) {
      next.delete(key);
      saved.getAll(key).forEach((value) => next.append(key, value));
    }
    setParams(next, { replace: true });
  }, [hasSelection, live.loaded, live.servers, params, setParams]);

  const sources = useMemo(() => selected.map((id) => {
    const index = live.servers.findIndex((server) => server.id === id);
    return { id, label: live.servers[index]?.name ?? id, color: PALETTE[index % PALETTE.length] };
  }), [selected.join(','), live.servers]); // eslint-disable-line react-hooks/exhaustive-deps
  const xRange = useMemo(() => resolveRange(range), [data, JSON.stringify(range)]); // eslint-disable-line react-hooks/exhaustive-deps
  const bucket = data && Object.values(data).map((series) => describeBucket(series.bucketMs)).find(Boolean);
  const rangeLabel = describeRange(range);

  if (live.loaded && live.servers.length === 0) {
    return (
      <div className="page">
        <h1>비교</h1>
        <EmptyState title="등록된 서버가 없습니다" />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>비교</h1>
          <p className="subtitle">여러 서버의 같은 지표를 한 그래프에 겹쳐 봅니다. 서버 수에 제한이 없습니다.</p>
          <RefreshInterval />
        </div>
      </div>
      <div className="toolbar compare-toolbar">
        <Segmented options={METRIC_OPTIONS} value={showAll ? 'all' : metric.key} onChange={(value) => update({ metric: value })} />
        <RangePicker value={range} onChange={setRange} />
      </div>
      {tags.length > 0 && (
        <div className="chips tag-filter">
          <span className="hint">비교할 태그 (여러 개 선택 가능)</span>
          {tags.map((tag) => (
            <button
              key={tag}
              className="tag-filter-option"
              style={tagColorStyle(tag, getTagColor(live.settings?.tagColors, tag))}
              aria-label={`#${tag} 태그 서버 비교`}
              aria-pressed={activeTags.includes(tag)}
              onClick={() => toggleTag(tag)}
            >
              #{tag}
            </button>
          ))}
        </div>
      )}
      <div className="chips">
        <span className="hint" role="status">{selected.length}대 비교 중</span>
        {live.servers.map((server, index) => {
          const on = selected.includes(server.id);
          return (
            <button
              key={server.id}
              className={`select-chip ${on ? 'on' : ''}`}
              aria-pressed={on}
              style={on ? { borderColor: PALETTE[index % PALETTE.length], color: PALETTE[index % PALETTE.length] } : undefined}
              onClick={() => toggleServer(server.id)}
            >
              {on ? '✓ ' : ''}
              {server.name}
            </button>
          );
        })}
      </div>
      {!data || selected.length === 0 ? (
        <section className="panel">
          <EmptyState title={selected.length === 0 ? '비교할 서버를 위에서 선택하세요' :
            currentResult && 'error' in currentResult ? currentResult.error : '지표를 불러오는 중…'} />
        </section>
      ) : (
        <div className={showAll ? 'chart-grid' : undefined}>
          {(showAll ? METRICS : [metric]).map((metric) => (
            <ComparisonMetricChart key={metric.key} metric={metric} sources={sources} data={data}
              xRange={xRange} rangeLabel={rangeLabel} bucket={bucket} showAll={showAll}
              warn={metric.warnKey && live.settings ? live.settings[metric.warnKey] : undefined}
              onSharedZoom={(from, to) => setRange({ kind: 'fixed', from, to })} />
          ))}
        </div>
      )}
    </div>
  );
}
