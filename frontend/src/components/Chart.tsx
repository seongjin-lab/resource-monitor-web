import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import { formatValue } from '../api';
import { formatTime } from '../range';

export interface ChartSeries {
  label: string;
  color: string;
  values: (number | null | undefined)[];
}

interface Props {
  t: number[];
  series: ChartSeries[];
  unit: '%' | 'MB/s';
  max?: number;
  warn?: number;
  height?: number;
  spanGaps?: boolean;
  cursorTooltip?: boolean;
  /** x축 범위(ms). 지정하면 데이터가 없어도 이 범위를 그린다. */
  xRange?: { from: number; to: number };
  /** 차트에서 드래그한 구간(ms)을 알려 준다. 넘기지 않으면 드래그 확대를 끈다. */
  onZoom?: (from: number, to: number) => void;
}

/** x축 눈금: 하루 이상 간격이면 날짜, 아니면 24시간제 시각(간격이 1분 미만이면 초까지). */
function formatTick(seconds: number, step: number): string {
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (step >= 86400) return `${date.getMonth() + 1}/${date.getDate()}`;
  if (step < 60) return `${time}:${pad(date.getSeconds())}`;
  return date.getHours() === 0 && date.getMinutes() === 0 ? `${date.getMonth() + 1}/${date.getDate()}` : time;
}

const AXIS = '#8b95a7';
const GRID = 'rgba(139,149,167,0.14)';

interface ChartHover {
  x: number;
  y: number;
  above: boolean;
  time: number;
  samples: ({ value: string; time?: number } | null)[];
}

export function Chart(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const zoom = useRef(props.onZoom);
  const xRange = useRef(props.xRange);
  const [hover, setHover] = useState<ChartHover | null>(null);
  zoom.current = props.onZoom;
  xRange.current = props.xRange;
  const height = props.height ?? 220;
  const signature = [
    props.series.map((series) => series.label + series.color).join('|'),
    props.unit, props.max, props.warn, height, props.spanGaps, props.cursorTooltip, Boolean(props.onZoom),
  ].join('/');

  useEffect(() => {
    const element = container.current!;
    const warn = props.warn;
    if (props.cursorTooltip) setHover(null);
    const options: uPlot.Options = {
      width: element.clientWidth || 600,
      height,
      cursor: {
        drag: { x: Boolean(props.onZoom), y: false, setScale: false },
        points: { size: 6 },
      },
      legend: { show: true, live: true },
      scales: {
        x: {
          time: true,
          range: (_u, min, max) =>
            xRange.current ? [xRange.current.from / 1000, xRange.current.to / 1000] : [min, max],
        },
        y: {
          range: (_u, _min, max) => [0, props.max ?? Math.max(1, (max ?? 1) * 1.15)],
        },
      },
      axes: [
        {
          stroke: AXIS,
          grid: { stroke: GRID },
          ticks: { stroke: GRID },
          values: (_u, splits, _axis, _space, increment) => splits.map((value) => formatTick(value, increment)),
        },
        {
          stroke: AXIS,
          grid: { stroke: GRID },
          ticks: { stroke: GRID },
          size: 56,
          values: (_u, values) => values.map((value) => (props.unit === '%' ? `${value}%` : `${value}`)),
        },
      ],
      series: [
        {
          label: props.cursorTooltip ? '' : '시각',
          value: (_u, value) => props.cursorTooltip
            ? '마지막 측정값'
            : value == null ? '–' : new Date(value * 1000).toLocaleString('ko-KR', { hour12: false }),
        },
        ...props.series.map((series) => ({
          label: series.label,
          stroke: series.color,
          width: 1.6,
          fill: props.series.length === 1 ? `${series.color}26` : undefined,
          spanGaps: props.spanGaps,
          points: { show: (u: uPlot) => u.data[0].length === 1 },
          value: (u: uPlot, value: number | null, seriesIndex: number) => {
            if (!props.cursorTooltip) return formatValue(value, props.unit);
            const times = u.data[0];
            const values = u.data[seriesIndex];
            const range = xRange.current;
            for (let index = times.length - 1; index >= 0; index--) {
              const time = times[index] * 1000;
              if (range && time < range.from) break;
              if (range && time > range.to) continue;
              if (values[index] != null) return formatValue(values[index], props.unit);
            }
            return '기록 없음';
          },
        })),
      ],
      hooks: {
        setCursor: props.cursorTooltip ? [(u) => {
          const { idx, idxs, left, top } = u.cursor;
          if (idx == null || left == null || top == null || left < 0 || top < 0 || u.data[0][idx] == null) {
            setHover(null);
            return;
          }
          const above = top >= u.over.clientHeight / 2;
          setHover({
            x: Math.min(u.over.offsetLeft + left + 12, Math.max(0, u.width - 264)),
            y: u.over.offsetTop + top + (above ? -10 : 10),
            above,
            time: u.data[0][idx] * 1000,
            samples: props.series.map((_, index) => {
              const seriesIndex = index + 1;
              if (!u.series[seriesIndex].show) return null;
              const sampleIndex = idxs?.[seriesIndex];
              const value = sampleIndex == null ? null : u.data[seriesIndex][sampleIndex];
              const sampleTime = sampleIndex == null ? null : u.data[0][sampleIndex];
              return {
                value: formatValue(value, props.unit),
                time: value != null && sampleTime != null && Math.floor(sampleTime) !== Math.floor(u.data[0][idx])
                  ? sampleTime * 1000
                  : undefined,
              };
            }),
          });
        }] : undefined,
        setSelect: [
          (u) => {
            if (u.select.width > 4 && zoom.current) {
              const from = u.posToVal(u.select.left, 'x') * 1000;
              const to = u.posToVal(u.select.left + u.select.width, 'x') * 1000;
              zoom.current(from, to);
            }
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
          },
        ],
        draw: [
          (u) => {
            if (warn == null) return;
            const y = u.valToPos(warn, 'y', true);
            const { ctx, bbox } = u;
            ctx.save();
            ctx.strokeStyle = 'rgba(245,184,74,0.7)';
            ctx.setLineDash([6, 4]);
            ctx.lineWidth = devicePixelRatio;
            ctx.beginPath();
            ctx.moveTo(bbox.left, y);
            ctx.lineTo(bbox.left + bbox.width, y);
            ctx.stroke();
            ctx.restore();
          },
        ],
      },
    };
    const instance = new uPlot(options, [props.t, ...props.series.map((series) => series.values)] as uPlot.AlignedData, element);
    plot.current = instance;
    const observer = new ResizeObserver(() => instance.setSize({ width: element.clientWidth, height }));
    observer.observe(element);
    return () => {
      observer.disconnect();
      instance.destroy();
      plot.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => {
    const instance = plot.current;
    if (!instance) return;
    instance.batch(() => {
      instance.setData([props.t, ...props.series.map((series) => series.values)] as uPlot.AlignedData);
      const range = xRange.current;
      if (range) instance.setScale('x', { min: range.from / 1000, max: range.to / 1000 });
    });
  }, [props.t, props.series, props.xRange?.from, props.xRange?.to, props.cursorTooltip]);

  if (!props.cursorTooltip) return <div ref={container} className="chart" />;

  return (
    <div className="chart-with-tooltip">
      <div ref={container} className="chart" />
      {hover && (
        <div className="chart-tooltip" aria-hidden="true" style={{ left: hover.x, top: hover.y, transform: hover.above ? 'translateY(-100%)' : undefined }}>
          <div className="chart-tooltip-time">{formatTime(hover.time)}</div>
          {props.series.map((series, index) => {
            const sample = hover.samples[index];
            if (!sample) return null;
            return (
              <div className="chart-tooltip-value" key={index}>
                <span>
                  <i style={{ background: series.color }} />{series.label}
                  {sample.time != null && <small>{formatTime(sample.time, false)}</small>}
                </span>
                <strong>{sample.value}</strong>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
