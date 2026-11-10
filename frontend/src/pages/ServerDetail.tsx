import { useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useDialogs } from '../App';
import { api, formatValue, METRICS, warnLevel } from '../api';
import { Chart } from '../components/Chart';
import { EmptyState, RangePicker, StatusChip, TagList, toast } from '../components/Common';
import { deleteServerWithConfirm } from '../components/Dialogs';
import { refreshServers, useLive, useSeries } from '../live';
import { describeBucket, describeRange, parseRange, RangeSpec, rangeParams, relativeAgo } from '../range';
import { METRIC_COLORS } from './Overview';

export default function ServerDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const live = useLive();
  const { openServer } = useDialogs();
  const range = useMemo(() => parseRange(params), [params]);
  const server = live.servers.find((item) => item.id === id);
  const { data, bounds, error, loading } = useSeries(server?.id, range);
  const setRange = (next: RangeSpec) => setParams(rangeParams(next));
  const graphs = useMemo(() => data ? METRICS.map((metric) => ({
    metric,
    hasValues: data[metric.key].some((value) => value != null),
    series: [{ label: metric.label, color: METRIC_COLORS[metric.key], values: data[metric.key] }],
  })) : [], [data]);

  if (!server) {
    return (
      <div className="page">
        <EmptyState title={live.loaded ? '서버를 찾을 수 없습니다' : '불러오는 중…'} />
      </div>
    );
  }

  const toggle = async () => {
    try {
      await api.setEnabled(server.id, !server.enabled);
      await refreshServers();
      toast(server.enabled ? '수집을 껐습니다. 기존 기록은 그대로 남습니다.' : '수집을 다시 시작합니다.');
    } catch (reason) {
      toast((reason as Error).message, 'error');
    }
  };

  const remove = async () => {
    if (await deleteServerWithConfirm(server)) navigate('/');
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast('현재 화면 링크를 복사했습니다.');
    } catch {
      toast('링크를 복사하지 못했습니다. 주소창의 URL을 복사하세요.', 'error');
    }
  };

  const bucket = data ? describeBucket(data.bucketMs) : null;
  const metrics = METRICS.map((metric) => {
    const value = server.latest?.[metric.key];
    return { metric, value, level: server.status === 'ok' ? warnLevel(metric, value, live.settings) : 'normal' as const };
  });
  const warnings = metrics.filter(({ level }) => level !== 'normal');
  const rangeLabel = describeRange(range);
  const boundsLabel = bounds && range.kind === 'relative'
    ? describeRange({ kind: 'fixed', ...bounds })
    : null;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="detail-title">
            {server.name}
            {warnings.length === 0
              ? <StatusChip status={server.status} />
              : warnings.map(({ metric, level }) => (
                <span key={metric.key} className={`chip card-alert-${level}`}>
                  {metric.key === 'disk' ? '디스크' : metric.label} {level === 'critical' ? '위험' : '경고'}
                </span>
              ))}
          </h1>
          <p className="subtitle">
            {server.user}@{server.host}:{server.port} · 마지막 갱신 {relativeAgo(server.lastUtc)} <TagList tags={server.tags} />
          </p>
        </div>
        <div className="row">
          <button className="button ghost" onClick={copyLink}>링크 복사</button>
          <button className="button ghost" onClick={toggle}>{server.enabled ? '수집 끄기' : '수집 켜기'}</button>
          <button className="button ghost" onClick={() => openServer(server)}>설정</button>
          <button className="button danger" onClick={remove}>삭제</button>
        </div>
      </div>
      {server.status === 'error' && <div className="banner error">{server.error}</div>}

      <section aria-labelledby="current-metrics">
        <h2 id="current-metrics" className="detail-metrics-title">현재 측정값</h2>
        <div className="tiles">
          {metrics.map(({ metric, value, level }) => (
            <div key={metric.key} className={`tile level-${level}`}>
              <span className="metric-label">{metric.label}</span>
              <span className="tile-value">{formatValue(value, metric.unit)}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="toolbar detail-toolbar">
        <RangePicker key={server.id} value={range} onChange={setRange} />
        {bounds ? (
          <a className="button ghost detail-csv" href={api.csvUrl(server.id, bounds.from, bounds.to)} download>
            CSV 내려받기
          </a>
        ) : (
          <button className="button ghost detail-csv" disabled>CSV 내려받기</button>
        )}
      </div>
      <div className="row detail-range-info">
        <span>조회 기간 · {rangeLabel}{boundsLabel && ` · ${boundsLabel}`}{bucket && ` · ${bucket}`}</span>
        {graphs.some(({ hasValues }) => hasValues) && <span>그래프를 드래그하면 구간을 확대합니다.</span>}
      </div>
      {error && <div className="banner error" role="alert">지표 조회 실패 · {error}</div>}

      {loading ? (
        <div className="panel" role="status"><EmptyState title="지표를 불러오는 중…" /></div>
      ) : data && bounds && (
        data.t.length === 0 ? (
          <div className="panel"><EmptyState title="조회 기간에 수집 기록이 없습니다" /></div>
        ) : (
          <div className="chart-grid">
            {graphs.map(({ metric, hasValues, series }) => {
              const warn = metric.warnKey && live.settings ? live.settings[metric.warnKey] : undefined;
              return (
                <section key={metric.key} className="panel">
                  <div className="row chart-heading">
                    <h3>{metric.label}{metric.unit === 'MB/s' ? ` (${metric.unit})` : ''}</h3>
                    {warn != null && <span className="hint chart-warning">경고 기준 {warn}%</span>}
                  </div>
                  {hasValues ? (
                    <Chart
                      t={data.t}
                      series={series}
                      unit={metric.unit}
                      max={metric.max}
                      warn={warn}
                      syncKey={`detail-${server.id}`}
                      cursorTooltip
                      xRange={bounds}
                      onZoom={(from, to) => setRange({ kind: 'fixed', from, to })}
                    />
                  ) : <EmptyState title="조회 기간에 이 지표의 기록이 없습니다" />}
                </section>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
