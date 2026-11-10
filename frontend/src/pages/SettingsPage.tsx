import { FormEvent, useEffect, useState } from 'react';
import { useBlocker } from 'react-router-dom';
import { allTags, criticalThreshold, METRICS, Settings } from '../api';
import { Modal } from '../components/Dialogs';
import { saveSettings, useLive } from '../live';
import { getTagColor, TAG_PALETTE, tagColorStyle } from '../tagColors';

const RETENTION_MAX = 3650;
const WARN_MAX = 100;
type NumericSetting = Exclude<keyof Settings, 'tagColors'>;

function numberError(value: string, max: number, unit: string, integer = false) {
  if (value === '') return '값을 입력하세요.';
  const number = Number(value);
  if (number < 1 || number > max || !Number.isFinite(number) || (integer && !Number.isInteger(number))) {
    return `1~${max}${unit} ${integer ? '사이의 정수를' : '사이의 값을'} 입력하세요.`;
  }
  return null;
}

function NumberSetting({ id, label, value, max, hint, error, integer = false, disabled, onChange }: {
  id: string;
  label: string;
  value: string;
  max: number;
  hint: string;
  error: string | null;
  integer?: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        min={1}
        max={max}
        step={integer ? 1 : 'any'}
        value={value}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
      />
      <small id={`${id}-hint`}>{hint}</small>
      {error && <small id={`${id}-error`} className="settings-field-error">{error}</small>}
    </div>
  );
}

export default function SettingsPage() {
  const { settings, intervalChoices, servers } = useLive();
  const [draft, setDraft] = useState<Partial<Record<NumericSetting, string>>>({});
  const [tagColorDraft, setTagColorDraft] = useState(new Map<string, string | null>());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const colorChanges = [...tagColorDraft].filter(([tag, color]) => color !== getTagColor(settings?.tagColors, tag));
  const dirty = settings != null && (colorChanges.length > 0 || (Object.keys(draft) as NumericSetting[])
    .some((key) => draft[key] === '' || Number(draft[key]) !== settings[key]));
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    (dirty || saving) && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!dirty && !saving) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, saving]);

  if (!settings) return <div className="page"><h1>설정</h1><p className="hint">설정을 불러오는 중…</p></div>;

  const value = (key: NumericSetting) => draft[key] ?? String(settings[key]);
  const set = (key: NumericSetting, input: string) => {
    setDraft((current) => ({ ...current, [key]: input }));
    setSaved(false);
    setSaveError(null);
  };
  const setTagColor = (tag: string, color: string | null) => {
    setTagColorDraft((current) => {
      const next = new Map(current);
      if (color === getTagColor(settings.tagColors, tag)) next.delete(tag);
      else next.set(tag, color);
      return next;
    });
    setSaved(false);
    setSaveError(null);
  };
  const reset = () => {
    setDraft({});
    setTagColorDraft(new Map());
    setSaved(false);
    setSaveError(null);
  };

  const retention = value('retentionDays');
  const tags = allTags(servers);
  const retentionError = numberError(retention, RETENTION_MAX, '일', true);
  const thresholds = METRICS.flatMap(({ label, warnKey }) => {
    if (!warnKey) return [];
    const input = value(warnKey);
    return [{
      key: warnKey,
      label,
      input,
      error: numberError(input, WARN_MAX, '%'),
    }];
  });
  const next: Settings = {
    intervalSeconds: Number(value('intervalSeconds')),
    retentionDays: Number(retention),
    cpuWarn: Number(value('cpuWarn')),
    memoryWarn: Number(value('memoryWarn')),
    diskWarn: Number(value('diskWarn')),
    tagColors: Object.fromEntries(colorChanges),
  };
  const canSave = dirty && !saving && !retentionError &&
    intervalChoices.includes(next.intervalSeconds) && thresholds.every(({ error }) => !error);
  const shorterRetention = !retentionError && next.retentionDays < settings.retentionDays;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveSettings(next);
      setDraft({});
      setTagColorDraft(new Map());
      setSaved(true);
    } catch (reason) {
      setSaveError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page narrow">
      <div className="page-header">
        <div>
          <h1>설정</h1>
          <p className="subtitle">저장하면 팀 전체에 바로 적용됩니다.</p>
        </div>
      </div>
      <form className="panel form settings-form" onSubmit={save} noValidate>
        <h2>수집 및 보관</h2>
        <div className="field">
          <label htmlFor="intervalSeconds">갱신 주기</label>
          <select id="intervalSeconds" value={value('intervalSeconds')} disabled={saving} aria-describedby="interval-hint"
            onChange={(event) => set('intervalSeconds', event.target.value)}>
            {intervalChoices.map((seconds) => (
              <option key={seconds} value={seconds}>{seconds}초</option>
            ))}
          </select>
          <small id="interval-hint">모든 서버를 이 주기로 조회합니다. 짧을수록 서버 부하와 DB 크기가 늘어납니다.</small>
        </div>
        <NumberSetting id="retentionDays" label="기록 보관 기간 (일)" value={retention} max={RETENTION_MAX}
          integer disabled={saving} error={retentionError}
          hint={`1~${RETENTION_MAX}일 · 보관 기간이 지난 기록은 1시간마다 자동으로 정리합니다.`}
          onChange={(input) => set('retentionDays', input)} />
        {shorterRetention && (
          <div className="settings-retention-warning">
            <strong>기록 보관 기간 {settings.retentionDays}일 → {next.retentionDays}일</strong>
            <div>저장하면 다음 자동 정리에서 {next.retentionDays}일이 지난 기록이 삭제됩니다.</div>
          </div>
        )}
        <h2>경고 기준</h2>
        <p className="hint">경고는 노란색, 위험은 빨간색으로 표시합니다.</p>
        <div className="settings-thresholds">
          {thresholds.map(({ key, label, input, error }) => {
            const warn = Number(input);
            return (
              <div className="settings-threshold" key={key}>
                <NumberSetting id={key} label={label} value={input} max={WARN_MAX}
                  disabled={saving} error={error} hint={`1~${WARN_MAX}%`} onChange={(input) => set(key, input)} />
                {!error && (
                  <div className="settings-threshold-preview">
                    <span className="settings-warn">경고 {warn}%</span>
                    <span className="settings-critical">위험 {criticalThreshold(warn)}%</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <h2>태그 색상</h2>
        <p className="hint">태그마다 색을 고를 수 있습니다. 자동을 선택하면 태그 이름에 따라 색이 정해집니다.</p>
        {tags.length === 0 && <p className="hint">서버에 태그를 추가하면 여기에서 색을 설정할 수 있습니다.</p>}
        {tags.map((tag) => {
          const draftColor = tagColorDraft.get(tag);
          const selected = draftColor === undefined ? getTagColor(settings.tagColors, tag) : draftColor;
          return (
            <div key={tag} className="tag-palette-row">
              <span className="tag" style={tagColorStyle(tag, selected)}>#{tag}</span>
              <div className="tag-palette" role="group" aria-label={`#${tag} 색상`}>
                <button className="button ghost" type="button" aria-pressed={selected === null}
                  disabled={saving} onClick={() => setTagColor(tag, null)}>자동</button>
                {TAG_PALETTE.map(({ color, label }) => (
                  <button key={color} className="tag-swatch" type="button" style={{ backgroundColor: color }}
                    title={label} aria-label={label} aria-pressed={selected === color}
                    disabled={saving} onClick={() => setTagColor(tag, color)}>
                    {selected === color && <span aria-hidden="true">✓</span>}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {saveError && <div className="banner error" role="alert">설정을 저장하지 못했습니다. {saveError}</div>}
        <footer>
          <span className="hint" role="status">
            {dirty ? '저장하지 않은 변경 사항' : saved ? '팀 설정에 적용했습니다.' : '변경 사항 없음'}
          </span>
          <button className="button ghost" type="button" onClick={reset} disabled={!dirty || saving}>되돌리기</button>
          <button className="button primary" type="submit" disabled={!canSave}>{saving ? '저장하는 중…' : '저장'}</button>
        </footer>
      </form>
      {blocker.state === 'blocked' && (
        <Modal title={dirty ? '저장하지 않은 변경 사항' : '설정 화면에서 나가기'} onClose={blocker.reset}>
          <div className="form">
            <p>{saving ? '설정을 저장하는 중입니다.' : dirty ? '이 화면을 나가면 편집한 값이 사라집니다.' : '변경 사항이 적용되었습니다.'}</p>
            <footer>
              <button className="button ghost" onClick={blocker.reset} autoFocus>화면에 머물기</button>
              <button className="button danger" onClick={blocker.proceed} disabled={saving}>
                {dirty ? '변경 사항 버리고 나가기' : '나가기'}
              </button>
            </footer>
          </div>
        </Modal>
      )}
    </div>
  );
}
