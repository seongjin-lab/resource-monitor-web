import { ReactNode, useEffect, useState } from 'react';
import { ServerStatus } from '../api';
import { PRESETS, RangeSpec, resolveRange, toLocalInput } from '../range';

const STATUS_LABEL: Record<ServerStatus, string> = {
  ok: '정상',
  connecting: '연결 중',
  error: '오류',
  disabled: '수집 꺼짐',
};

export function StatusDot({ status }: { status: ServerStatus }) {
  return <span className={`dot dot-${status}`} title={STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]} />;
}

export function StatusChip({ status }: { status: ServerStatus }) {
  return (
    <span className={`chip chip-${status}`}>
      <StatusDot status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Segmented<T extends string | number>({ options, value, onChange }: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((option) => (
        <button
          key={String(option.value)}
          role="tab"
          aria-selected={option.value === value}
          className={option.value === value ? 'active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** 빠른 범위 버튼 + 사용자 지정 기간. 고정 범위일 때는 "최신으로" 버튼을 보여 준다. */
export function RangePicker({ value, onChange }: { value: RangeSpec; onChange: (range: RangeSpec) => void }) {
  const [custom, setCustom] = useState(value.kind === 'fixed');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const fixedFrom = value.kind === 'fixed' ? value.from : null;
  const fixedTo = value.kind === 'fixed' ? value.to : null;

  useEffect(() => {
    if (fixedFrom != null && fixedTo != null) {
      setCustom(true);
      setFrom(toLocalInput(fixedFrom));
      setTo(toLocalInput(fixedTo));
    }
  }, [fixedFrom, fixedTo]);

  const toggleCustom = () => {
    if (custom) {
      setCustom(false);
      return;
    }
    const { from, to } = resolveRange(value);
    setFrom(toLocalInput(from));
    setTo(toLocalInput(to));
    setCustom(true);
  };

  const apply = () => {
    const start = new Date(from).getTime();
    const end = new Date(to).getTime();
    if (start > 0 && end > start) onChange({ kind: 'fixed', from: start, to: end });
  };

  return (
    <div className="range-picker">
      <div className="segmented">
        {PRESETS.map((preset) => (
          <button
            key={preset.minutes}
            className={value.kind === 'relative' && value.minutes === preset.minutes ? 'active' : ''}
            aria-pressed={value.kind === 'relative' && value.minutes === preset.minutes}
            onClick={() => {
              setCustom(false);
              onChange({ kind: 'relative', minutes: preset.minutes });
            }}
          >
            {preset.label}
          </button>
        ))}
        <button className={value.kind === 'fixed' ? 'active' : ''} aria-expanded={custom} onClick={toggleCustom}>
          사용자 지정
        </button>
      </div>
      {custom && (
        <div className="custom-range">
          <input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} aria-label="시작 시각" />
          <span>~</span>
          <input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} aria-label="종료 시각" />
          <button className="button" onClick={apply}>
            조회
          </button>
          {value.kind === 'fixed' && (
            <button
              className="button ghost"
              onClick={() => {
                setCustom(false);
                onChange({ kind: 'relative', minutes: 15 });
              }}
            >
              최신으로
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function TagList({ tags }: { tags: string[] }) {
  if (!tags?.length) return null;
  return (
    <span className="tags">
      {tags.map((tag) => (
        <span key={tag} className="tag">#{tag}</span>
      ))}
    </span>
  );
}

/** 태그 하나를 고르면 그 태그가 붙은 서버만 보이게 하는 필터. 선택 해제는 "전체". */
export function TagFilter({ tags, value, onChange }: { tags: string[]; value: string | null; onChange: (tag: string | null) => void }) {
  if (tags.length === 0) return null;
  return (
    <div className="tag-filter" role="group" aria-label="태그로 거르기">
      <button className={value === null ? 'active' : ''} onClick={() => onChange(null)}>전체</button>
      {tags.map((tag) => (
        <button key={tag} className={value === tag ? 'active' : ''} onClick={() => onChange(value === tag ? null : tag)}>
          #{tag}
        </button>
      ))}
    </div>
  );
}

/** 칩 형태 태그 입력. Enter·쉼표로 추가하고, 빈 입력에서 Backspace로 마지막 태그를 지운다. */
export function TagInput({ value, onChange, suggestions, text, onTextChange, disabled }: {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
  text: string;
  onTextChange: (text: string) => void;
  disabled: boolean;
}) {
  const add = (raw: string) => {
    const tags = [...value];
    for (const part of raw.split(',')) {
      const tag = part.trim().replace(/^#/, '').trim().slice(0, 30);
      if (tag && tags.length < 10 && !tags.some((item) => item.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    }
    if (tags.length !== value.length) onChange(tags);
    onTextChange('');
  };
  const unused = suggestions.filter((tag) => !value.includes(tag));
  return (
    <div className="tag-input">
      {value.map((tag) => (
        <span key={tag} className="tag">
          #{tag}
          <button type="button" disabled={disabled} aria-label={`${tag} 태그 빼기`} onClick={() => onChange(value.filter((item) => item !== tag))}>×</button>
        </span>
      ))}
      <input
        value={text}
        id="server-tags"
        aria-describedby="server-tags-hint"
        disabled={disabled}
        list="tag-suggestions"
        placeholder={value.length ? '' : '예: nh, 운영, 4.7'}
        onChange={(event) => {
          const next = event.target.value;
          if (next.endsWith(',')) add(next.slice(0, -1));
          else onTextChange(next);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            add(text);
          } else if (event.key === 'Backspace' && !text && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => text && add(text)}
      />
      <datalist id="tag-suggestions">
        {unused.map((tag) => <option key={tag} value={tag} />)}
      </datalist>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

// ---- 알림 토스트 ----
type Toast = { id: number; text: string; kind: 'info' | 'error' };
let toasts: Toast[] = [];
let toastListener: ((items: Toast[]) => void) | null = null;
let toastId = 0;

export function toast(text: string, kind: Toast['kind'] = 'info') {
  const item = { id: ++toastId, text, kind };
  toasts = [...toasts, item];
  toastListener?.(toasts);
  window.setTimeout(() => {
    toasts = toasts.filter((entry) => entry.id !== item.id);
    toastListener?.(toasts);
  }, kind === 'error' ? 6000 : 3500);
}

export function Toasts() {
  const [items, setItems] = useState<Toast[]>(toasts);
  useEffect(() => {
    toastListener = setItems;
    return () => {
      toastListener = null;
    };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`toast toast-${item.kind}`}>
          {item.text}
        </div>
      ))}
    </div>
  );
}
