import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useDialogs } from '../App';
import { allTags, api, formatValue, METRICS, Series, ServerStatus, warnLevel } from '../api';
import { Sparkline } from '../components/Chart';
import { EmptyState, Segmented, StatusChip, TagFilter, TagList } from '../components/Common';
import { appendSample, onSample, useLive } from '../live';
import { relativeAgo } from '../range';

export const METRIC_COLORS = { cpu: '#5fd3a8', memory: '#6aa8ff', disk: '#c08bff', io: '#f5b84a' } as const;
const WINDOW_MINUTES = 15;

function serverLevel(status: ServerStatus, levels: ReturnType<typeof warnLevel>[]): Exclude<ServerStatus, 'ok'> | ReturnType<typeof warnLevel> {
  if (status !== 'ok') return status;
  if (levels.includes('critical')) return 'critical';
  return levels.includes('warn') ? 'warn' : 'normal';
}

export default function Overview() {
  const live = useLive();
  const { openServer, openImport } = useDialogs();
  const [recent, setRecent] = useState<Record<string, Series>>({});
  const [recentRequest, setRecentRequest] = useState<{ key: string; failed: boolean }>();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'problem' ? 'problem' : 'all';
  const tags = allTags(live.servers);
  const tag = params.get('tag');
  const activeTag = tag && tags.includes(tag) ? tag : null;
  const serverKey = live.servers.map((server) => server.id).join(',');

  const setFilter = (name: 'view' | 'tag', value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next);
  };

  useEffect(() => {
    if (!serverKey) return;
    let cancelled = false;
    api.recent(WINDOW_MINUTES, 90)
      .then((data) => {
        if (cancelled) return;
        setRecent(data);
        setRecentRequest({ key: serverKey, failed: false });
      })
      .catch(() => {
        if (!cancelled) setRecentRequest({ key: serverKey, failed: true });
      });
    const unsubscribe = onSample((sample) =>
      setRecent((current) => {
        const series = current[sample.serverId] ?? { bucketMs: 0, t: [], cpu: [], memory: [], disk: [], io: [] };
        return { ...current, [sample.serverId]: appendSample(series, sample, WINDOW_MINUTES * 60) };
      }),
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [serverKey]);

  const cards = useMemo(() => live.servers.map((server) => {
    const metrics = METRICS.map((metric) => {
      const value = server.latest?.[metric.key];
      return {
        ...metric,
        label: metric.key === 'disk' ? '디스크 사용률' : metric.label,
        value,
        level: server.status === 'ok' ? warnLevel(metric, value, live.settings) : 'normal' as const,
      };
    });
    return { server, metrics, level: serverLevel(server.status, metrics.map((metric) => metric.level)) };
  }), [live.servers, live.settings]);

  if (live.loaded && live.servers.length === 0) {
    return (
      <div className="page">
        <h1>전체 현황</h1>
        <EmptyState title="등록된 서버가 없습니다">
          <p>SSH로 접속할 리눅스 서버를 등록하면 바로 수집을 시작합니다.</p>
          <div className="row">
            <button className="button primary" onClick={() => openServer()}>+ 서버 등록</button>
            <button className="button ghost" onClick={openImport}>.rmon 파일 가져오기</button>
          </div>
        </EmptyState>
      </div>
    );
  }

  const counts = { normal: 0, warn: 0, error: 0, disabled: 0, connecting: 0 };
  for (const { level } of cards) counts[level === 'critical' ? 'warn' : level]++;
  const byTag = cards.filter(({ server }) => !activeTag || server.tags.includes(activeTag));
  const problemOrder = { error: 0, critical: 1, warn: 2 };
  const problems = byTag
    .flatMap((card) => {
      const { level } = card;
      return level === 'error' || level === 'critical' || level === 'warn' ? [{ card, rank: problemOrder[level] }] : [];
    })
    .sort((a, b) => a.rank - b.rank)
    .map(({ card }) => card);
  const shown = view === 'problem' ? problems : byTag;
  const trendMessage = recentRequest?.key !== serverKey
    ? '추이 불러오는 중…'
    : recentRequest.failed ? '추이를 불러오지 못했습니다' : '수집된 추이가 아직 없습니다';

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>전체 현황</h1>
          <p className="subtitle">
            최근 {WINDOW_MINUTES}분 추이 · {live.settings ? `${live.settings.intervalSeconds}초마다 갱신` : ''}
          </p>
        </div>
        <div className="summary">
          <span className="hint">전체 서버 {cards.length}대</span>
          <span className="summary-item ok">정상 {counts.normal}</span>
          <span className="summary-item warn">경고 {counts.warn}</span>
          <span className="summary-item error">오류 {counts.error}</span>
          {counts.connecting > 0 && <span className="summary-item muted">연결 중 {counts.connecting}</span>}
          {counts.disabled > 0 && <span className="summary-item muted">꺼짐 {counts.disabled}</span>}
        </div>
      </div>
      <div className="toolbar">
        <div className="row overview-filters">
          <Segmented
            options={[
              { value: 'all', label: '전체' },
              { value: 'problem', label: `문제 있는 서버 (${problems.length})` },
            ]}
            value={view}
            onChange={(value) => setFilter('view', value === 'problem' ? value : null)}
          />
          {tags.length > 0 && (
            <div className="row">
              <span className="hint">카드 태그 필터</span>
              <TagFilter tags={tags} value={activeTag} onChange={(value) => setFilter('tag', value)} />
            </div>
          )}
          <span className="hint" role="status">{shown.length}대 표시</span>
        </div>
        <div className="legend">
          {METRICS.slice(0, 2).map((metric) => (
            <span key={metric.key}><i style={{ background: METRIC_COLORS[metric.key] }} />{metric.label}</span>
          ))}
        </div>
      </div>
      {!live.loaded && <EmptyState title="서버 목록을 불러오는 중…" />}
      {live.loaded && shown.length === 0 && (
        <EmptyState title={activeTag ? `#${activeTag} 그룹에 문제 있는 서버가 없습니다` : '문제 있는 서버가 없습니다'}>
          {activeTag && <button className="button ghost" onClick={() => setFilter('tag', null)}>태그 필터 해제</button>}
        </EmptyState>
      )}
      <div className="card-grid">
        {shown.map(({ server, metrics, level }) => {
          const series = recent[server.id];
          const warnings = metrics
            .filter((metric) => metric.level !== 'normal')
            .map((metric) => `${metric.label} ${metric.level === 'critical' ? '위험' : '경고'}`);
          return (
            <Link key={server.id} to={`/servers/${server.id}`} className={`server-card level-${level}`}>
              <div className="card-head">
                <div>
                  <div className="card-title">{server.name}</div>
                  <div className="card-sub">
                    {server.host}{server.port !== 22 ? `:${server.port}` : ''} <TagList tags={server.tags} />
                  </div>
                </div>
                {warnings.length > 0
                  ? <span className={`chip card-alert card-alert-${level}`}>{warnings.join(' · ')}</span>
                  : <StatusChip status={server.status} />}
              </div>
              {server.status === 'error' && <div className="card-error">{server.error}</div>}
              <div className="metric-row">
                {metrics.map(({ key, label, value, unit, max, level }) => (
                  <div key={key} className={`metric level-${level}`}>
                    <span className="metric-label">{label}</span>
                    <span className="metric-value">{server.status === 'disabled' ? '–' : formatValue(value, unit)}</span>
                    {max && value != null && server.status !== 'disabled' && (
                      <span className="bar"><span style={{ width: `${Math.min(100, value)}%` }} /></span>
                    )}
                  </div>
                ))}
              </div>
              <div className="card-spark">
                {series && series.t.length > 1 ? (
                  <>
                    <Sparkline t={series.t} values={series.cpu} color={METRIC_COLORS.cpu} width={300} height={40} />
                    <Sparkline t={series.t} values={series.memory} color={METRIC_COLORS.memory} width={300} height={40} />
                  </>
                ) : (
                  <span className="hint">{trendMessage}</span>
                )}
              </div>
              <div className="card-foot">마지막 갱신 {relativeAgo(server.lastUtc)}</div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
