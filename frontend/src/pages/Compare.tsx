import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import uPlot from 'uplot';
import { allTags, api, MetricKey, METRICS, Series } from '../api';
import { Chart, ChartSeries } from '../components/Chart';
import { EmptyState, RangePicker, Segmented } from '../components/Common';
import { appendSample, onSample, useLive } from '../live';
import { describeBucket, describeRange, parseRange, RangeSpec, rangeParams, resolveRange } from '../range';
import { getTagColor, tagColorStyle } from '../tagColors';

const PALETTE = ['#5fd3a8', '#6aa8ff', '#f5b84a', '#ef6f8a', '#c08bff', '#4fd1e0', '#e8e86a', '#ff9a5c'];

/** 여러 서버의 같은 지표를 한 그래프에 겹쳐 본다. 선택 상태와 범위는 URL에 남아 링크로 공유할 수 있다. */
export default function Compare() {
  const live = useLive();
  const [params, setParams] = useSearchParams();
  const range = parseRange(params);
  const metricKey = (params.get('metric') as MetricKey) || 'cpu';
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
  const key = selected.join(',') + JSON.stringify(range);
  const [result, setResult] = useState<{ key: string; data: Record<string, Series> } | { key: string; error: string }>();
  const currentResult = result?.key === key ? result : undefined;
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

  // 처음 들어오면 켜진 서버를 최대 4대 골라 둔다.
  useEffect(() => {
    if (!params.has('servers') && !params.has('tag') && live.servers.length > 0) {
      const servers = live.servers.filter((server) => server.enabled).slice(0, 4).map((server) => server.id).join(',');
      update({ tag: null, previousServers: null, servers });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.servers.length]);

  useEffect(() => {
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

  const { t, series } = useMemo(() => {
    if (!data || selected.length === 0) return { t: [] as number[], series: [] as ChartSeries[] };
    const joined = uPlot.join(selected.map((id) => [data[id].t, data[id][metric.key]] as uPlot.AlignedData));
    return {
      t: joined[0] as number[],
      series: selected.map((id, index) => ({
        label: live.servers.find((server) => server.id === id)?.name ?? id,
        color: PALETTE[live.servers.findIndex((server) => server.id === id) % PALETTE.length],
        values: joined[index + 1] as (number | null)[],
      })),
    };
  }, [data, selected.join(','), metric.key, live.servers]); // eslint-disable-line react-hooks/exhaustive-deps

  const xRange = useMemo(() => resolveRange(range), [t, params.toString()]); // eslint-disable-line react-hooks/exhaustive-deps
  const bucket = data && Object.values(data).map((series) => describeBucket(series.bucketMs)).find(Boolean);
  const warn = metric.warnKey && live.settings ? live.settings[metric.warnKey] : undefined;
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
        </div>
      </div>
      <div className="toolbar compare-toolbar">
        <Segmented options={METRICS.map((item) => ({ value: item.key, label: item.label }))} value={metric.key} onChange={(value) => update({ metric: value })} />
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
      <section className="panel">
        <div className="row chart-heading">
          <h3>{metric.label}{metric.unit === 'MB/s' ? ` (${metric.unit})` : ''}</h3>
          {warn != null && <span className="hint chart-warning">경고 기준 {warn}%</span>}
          <span className="hint">조회 기간 · {rangeLabel}{bucket ? ` · ${bucket}` : ''}</span>
        </div>
        {selected.length === 0 ? (
          <EmptyState title="비교할 서버를 위에서 선택하세요" />
        ) : !data ? (
          <EmptyState title={currentResult && 'error' in currentResult ? currentResult.error : '지표를 불러오는 중…'} />
        ) : (
          <Chart
            t={t}
            series={series}
            unit={metric.unit}
            max={metric.max}
            warn={warn}
            height={380}
            spanGaps
            cursorTooltip
            xRange={xRange}
            onZoom={(from, to) => setRange({ kind: 'fixed', from, to })}
          />
        )}
      </section>
    </div>
  );
}
