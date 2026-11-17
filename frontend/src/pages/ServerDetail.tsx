import { useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useDialogs } from '../App';
import { api, formatValue, MetricDef, METRICS, Series, warnLevel } from '../api';
import { Chart, ChartZoomReset } from '../components/Chart';
import { EmptyState, RangePicker, StatusChip, TagList, toast } from '../components/Common';
import { deleteServerWithConfirm } from '../components/Dialogs';
import { RefreshInterval } from '../components/RefreshInterval';
import { refreshServers, useLive, useSeries } from '../live';
import { useMetricZoom } from '../metricZoom';
import { describeBucket, describeRange, parseRange, RangeSpec, rangeParams } from '../range';

const METRIC_COLORS = { cpu: '#5fd3a8', memory: '#6aa8ff', disk: '#c08bff', io: '#f5b84a' } as const;

function DetailMetricChart({ serverId, metric, data, range, bounds, warn }: {
  serverId: string;
  metric: MetricDef;
  data: Series;
  range: RangeSpec;
  bounds: { from: number; to: number };
  warn?: number;
}) {
  const { zoom, zoomTo, resetZoom } = useMetricZoom(metric.key);
  const { data: zoomData, error, loading } = useSeries(zoom ? serverId : undefined, zoom ?? range);
  const chartData = zoomData ?? data;
  const values = chartData[metric.key];
  const series = useMemo(() => [{ label: metric.label, color: METRIC_COLORS[metric.key], values }], [metric, values]);

  return (
    <section className="panel">
      <div className="row chart-heading">
        <h3>{metric.label}{metric.unit === 'MB/s' ? ` (${metric.unit})` : ''}</h3>
        {warn != null && <span className="hint chart-warning">경고 기준 {warn}%</span>}
        {loading && <span className="hint" role="status">확대 구간을 불러오는 중…</span>}
        {zoom && <ChartZoomReset label={metric.label} onReset={resetZoom} />}
      </div>
      {error && <div className="banner error" role="alert">확대 구간 조회 실패 · {error}</div>}
      {values.some((value) => value != null) ? (
        <Chart
          t={chartData.t}
          series={series}
          unit={metric.unit}
          max={metric.max}
          warn={warn}
          cursorTooltip
          xRange={zoom ?? bounds}
          onZoom={zoomTo}
        />
      ) : <EmptyState title="조회 기간에 이 지표의 기록이 없습니다" />}
    </section>
  );
}

export default function ServerDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const live = useLive();
  const { openServer } = useDialogs();
  const rangeSearch = new URLSearchParams([...params].filter(([key]) => ['range', 'from', 'to'].includes(key))).toString();
  const range = useMemo(() => parseRange(new URLSearchParams(rangeSearch)), [rangeSearch]);
  const server = live.servers.find((item) => item.id === id);
  const { data, bounds, error, loading } = useSeries(server?.id, range);
  const setRange = (next: RangeSpec) => setParams(rangeParams(next));

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
  const processWarnings = warnings.filter(({ metric }) => metric.key === 'cpu' || metric.key === 'memory');
  const diskWarning = warnings.some(({ metric }) => metric.key === 'disk');
  const rootDirectories = server.rootDirectories;
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
            {server.user}@{server.host}:{server.port} <TagList tags={server.tags} colors={live.settings?.tagColors} />
          </p>
          {server.specs ? (
            <p className="row hint">
              <span>논리 코어 {server.specs.logicalCores == null ? '–' : `${server.specs.logicalCores}개`}</span>
              <span>총 메모리 {formatValue(server.specs.memoryKiB / 1024 ** 2, 'GiB')}</span>
              <span>루트 디스크(/) {formatValue(server.specs.rootDiskKiB == null ? null : server.specs.rootDiskKiB / 1024 ** 2, 'GiB')}</span>
            </p>
          ) : <p className="hint">서버 사양 미수집</p>}
          <RefreshInterval />
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

      {(processWarnings.length > 0 || diskWarning) && (
        <div className="chart-grid detail-diagnostics">
          {processWarnings.map(({ metric }) => {
            const isCpu = metric.key === 'cpu';
            const processes = server.topProcesses?.[isCpu ? 'cpu' : 'memory'];
            return (
              <section key={metric.key} className="panel" aria-labelledby={`processes-${metric.key}`}>
                <h2 id={`processes-${metric.key}`} className="detail-metrics-title">{metric.label} 사용량 상위 프로세스</h2>
                {processes?.length ? (
                  <table className="diagnostic-table">
                    <thead>
                      <tr><th scope="col">PID</th><th scope="col">이름</th><th scope="col">{isCpu ? '사용률 (전체 코어 기준)' : '점유 메모리 (RSS)'}</th></tr>
                    </thead>
                    <tbody>
                      {processes.map((process) => (
                        <tr key={process.pid}>
                          <td>{process.pid}</td>
                          <td>{process.name}</td>
                          <td>{formatValue(process.usage, isCpu ? '%' : 'MiB')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <p className="hint">조회된 프로세스 정보가 없습니다.</p>}
              </section>
            );
          })}
          {diskWarning && (
            <section className="panel" aria-labelledby="disk-directories">
              <h2 id="disk-directories" className="detail-metrics-title">루트 디스크 사용량 상위 디렉터리</h2>
              {rootDirectories == null ? (
                <p className="hint" role="status">디렉터리 용량을 확인하는 중…</p>
              ) : rootDirectories.entries.length === 0 ? (
                <p className="hint">디렉터리 용량을 확인하지 못했습니다.</p>
              ) : (
                <>
                  {rootDirectories.isPartial && <p className="hint">일부 경로를 읽지 못해 확인한 용량만 표시합니다.</p>}
                  <table className="diagnostic-table">
                    <thead>
                      <tr><th scope="col">경로</th><th scope="col">용량</th></tr>
                    </thead>
                    <tbody>
                      {rootDirectories.entries.map(({ path, sizeKiB }) => (
                        <tr key={path}>
                          <td className="directory-path">{path}</td>
                          <td>{sizeKiB >= 1024 ** 2 ? formatValue(sizeKiB / 1024 ** 2, 'GiB')
                            : sizeKiB >= 1024 ? formatValue(sizeKiB / 1024, 'MiB') : formatValue(sizeKiB, 'KiB')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </section>
          )}
        </div>
      )}

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
        {data && METRICS.some(({ key }) => data[key].some((value) => value != null)) &&
          <span>그래프를 드래그하면 해당 지표만 확대됩니다.</span>}
      </div>
      {error && <div className="banner error" role="alert">지표 조회 실패 · {error}</div>}

      {loading ? (
        <div className="panel" role="status"><EmptyState title="지표를 불러오는 중…" /></div>
      ) : data && bounds && (
        data.t.length === 0 ? (
          <div className="panel"><EmptyState title="조회 기간에 수집 기록이 없습니다" /></div>
        ) : (
          <div className="chart-grid">
            {METRICS.map((metric) => (
              <DetailMetricChart key={metric.key} serverId={server.id} metric={metric} data={data} range={range} bounds={bounds}
                warn={metric.warnKey && live.settings ? live.settings[metric.warnKey] : undefined} />
            ))}
          </div>
        )
      )}
    </div>
  );
}
