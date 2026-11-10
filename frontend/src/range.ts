export type RangeSpec = { kind: 'relative'; minutes: number } | { kind: 'fixed'; from: number; to: number };

export const PRESETS = [
  { label: '15분', minutes: 15 },
  { label: '1시간', minutes: 60 },
  { label: '6시간', minutes: 360 },
  { label: '24시간', minutes: 1440 },
  { label: '7일', minutes: 10080 },
  { label: '30일', minutes: 43200 },
];

/** URL 쿼리(?range=60 또는 ?from=..&to=..)로 범위를 표현해 링크로 그대로 공유할 수 있게 한다. */
export function parseRange(params: URLSearchParams): RangeSpec {
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));
  if (from > 0 && to > from) return { kind: 'fixed', from, to };
  const minutes = Number(params.get('range'));
  return { kind: 'relative', minutes: minutes > 0 ? minutes : 15 };
}

export function rangeParams(range: RangeSpec): Record<string, string> {
  return range.kind === 'fixed'
    ? { from: String(Math.round(range.from)), to: String(Math.round(range.to)) }
    : { range: String(range.minutes) };
}

export function resolveRange(range: RangeSpec): { from: number; to: number } {
  if (range.kind === 'fixed') return { from: range.from, to: range.to };
  const to = Date.now();
  return { from: to - range.minutes * 60_000, to };
}

export function describeRange(range: RangeSpec): string {
  if (range.kind === 'fixed') return `${formatTime(range.from)} ~ ${formatTime(range.to)}`;
  const preset = PRESETS.find((item) => item.minutes === range.minutes);
  return `최근 ${preset?.label ?? `${range.minutes}분`}`;
}

export function toLocalInput(ms: number): string {
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

export function formatTime(ms: number, withDate = true): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return withDate ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}` : time;
}

export function describeBucket(bucketMs: number): string | null {
  if (!bucketMs) return null;
  const seconds = Math.round(bucketMs / 1000);
  if (seconds < 120) return `${seconds}초 평균`;
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes}분 평균` : `${Math.round(minutes / 60)}시간 평균`;
}

export function relativeAgo(ms: number | null): string {
  if (!ms) return '수집 기록 없음';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  return formatTime(ms);
}
