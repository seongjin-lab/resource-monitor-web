import { FormEvent, ReactNode, RefObject, useEffect, useId, useRef, useState } from 'react';
import { allTags, api, ApiError, Server, ServerInput } from '../api';
import { refreshServers, useLive } from '../live';
import { TagInput, toast } from './Common';

/** 확인을 받은 뒤 서버와 그 수집 기록을 삭제한다. 삭제했으면 true. */
export async function deleteServerWithConfirm(server: Server): Promise<boolean> {
  if (!window.confirm(`${server.name}을(를) 삭제할까요?\n이 서버의 수집 기록도 모두 지워지며 되돌릴 수 없습니다.`)) return false;
  try {
    await api.deleteServer(server.id);
    await refreshServers();
    toast(`${server.name}을(를) 삭제했습니다.`);
    return true;
  } catch (reason) {
    toast((reason as Error).message, 'error');
    return false;
  }
}

export function Modal({ title, onClose, children, initialFocus, closeDisabled }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  initialFocus?: RefObject<HTMLElement>;
  closeDisabled?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    ref.current?.showModal();
    initialFocus?.current?.focus();
  }, [initialFocus]);
  return (
    <dialog ref={ref} className="modal" aria-labelledby={titleId} onClose={onClose} onCancel={(event) => {
      event.preventDefault();
      if (!closeDisabled) onClose();
    }}>
      <header>
        <h2 id={titleId}>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="닫기" disabled={closeDisabled}>
          ✕
        </button>
      </header>
      {children}
    </dialog>
  );
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; fingerprint: string; memory: number | null; disk: number | null }
  | { kind: 'error'; message: string; fingerprint?: string };

/** 서버 등록·편집. 접속 테스트로 받은 호스트 키 지문을 사용자가 확인해야 저장할 수 있다. */
export function ServerDialog({ server, onClose, onSaved }: {
  server?: Server;
  onClose: () => void;
  onSaved?: (server: Server) => void;
}) {
  const editing = Boolean(server);
  const [initial] = useState(() => ({
    name: server?.name ?? '',
    host: server?.host ?? '',
    user: server?.user ?? '',
    authType: server?.authType ?? ('password' as const),
    password: '',
    privateKey: '',
    passphrase: '',
    tags: server?.tags ?? [],
  }));
  const [form, setForm] = useState(initial);
  const initialPort = String(server?.port ?? 22);
  const [portText, setPortText] = useState(initialPort);
  const [tagText, setTagText] = useState('');
  const [discard, setDiscard] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const keepEditingButton = useRef<HTMLButtonElement>(null);
  const keyFile = useRef<HTMLInputElement>(null);
  const testVersion = useRef(0);
  const fileVersion = useRef(0);
  const [readingKey, setReadingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const live = useLive();
  const tagSuggestions = allTags(live.servers);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [trusted, setTrusted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fingerprint = test.kind === 'ok' ? test.fingerprint : undefined;
  const fingerprintChanged = Boolean(server && fingerprint && fingerprint !== server.fingerprint);
  const port = Number(portText);
  const validPort = Number.isInteger(port) && port >= 1 && port <= 65535;
  const validName = form.name.trim().length >= 1 && form.name.trim().length <= 100;
  const storedAuth = server?.authType === form.authType;
  const missingAuth = form.authType === 'password' ? !form.password : !form.privateKey.trim();
  const missing = [
    !form.host.trim() && '주소',
    !validPort && '유효한 포트',
    !form.user.trim() && '계정',
    !storedAuth && missingAuth && (form.authType === 'password' ? '비밀번호' : '개인 키'),
  ].filter(Boolean);
  const canTest = missing.length === 0 && !readingKey && !saving && test.kind !== 'running';
  const input: ServerInput = {
    ...form,
    port,
    password: form.authType === 'password' ? form.password : undefined,
    privateKey: form.authType === 'key' ? form.privateKey : undefined,
    passphrase: form.authType === 'key' ? form.passphrase : undefined,
  };
  // 편집 중 접속 정보(주소·포트·계정·인증)를 바꾸지 않았다면 기존 지문을 그대로 쓴다.
  const connectionUnchanged =
    server &&
    form.host.trim() === server.host &&
    port === server.port &&
    form.user.trim() === server.user &&
    storedAuth &&
    !input.password &&
    !input.privateKey?.trim() &&
    !input.passphrase;
  const canSave = canTest && validName && (fingerprint ? trusted : connectionUnchanged);
  const step = missing.length ? 0 : fingerprint ? trusted ? 3 : 2 : 1;
  const dirty = portText !== initialPort || Boolean(tagText.trim()) ||
    (Object.keys(initial) as (keyof typeof initial)[]).some((key) =>
      key === 'tags' ? JSON.stringify(form.tags) !== JSON.stringify(initial.tags) : form[key] !== initial[key],
    );
  const close = () => {
    if (saving) return;
    if (dirty || readingKey) setDiscard(true);
    else onClose();
  };

  const invalidateTest = () => {
    testVersion.current++;
    setTest({ kind: 'idle' });
    setTrusted(false);
  };

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError(null);
    if (key !== 'name' && key !== 'tags') invalidateTest();
    if (key === 'authType' || key === 'privateKey') {
      fileVersion.current++;
      setReadingKey(false);
      setKeyError(null);
    }
  };

  const runTest = async () => {
    if (!canTest) return;
    const version = ++testVersion.current;
    setTest({ kind: 'running' });
    setTrusted(false);
    setError(null);
    try {
      const result = await api.testServer({ ...input, id: server?.id });
      if (version !== testVersion.current) return;
      setTest({ kind: 'ok', ...result });
      setTrusted(result.fingerprint === server?.fingerprint);
    } catch (reason) {
      if (version !== testVersion.current) return;
      const apiError = reason as ApiError;
      setTest({
        kind: 'error',
        message: apiError.message,
        fingerprint: typeof apiError.data?.fingerprint === 'string' ? apiError.data.fingerprint : undefined,
      });
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const payload = { ...input, fingerprint: fingerprint ?? server?.fingerprint };
    try {
      const saved = server ? await api.updateServer(server.id, payload) : await api.createServer(payload);
      await refreshServers();
      toast(editing ? `${saved.name} 설정을 저장했습니다.` : `${saved.name}을(를) 등록했습니다. 곧 수집을 시작합니다.`);
      onSaved?.(saved);
      onClose();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const loadKeyFile = async (file: File | undefined) => {
    if (!file) return;
    const version = ++fileVersion.current;
    setReadingKey(true);
    setKeyError(null);
    invalidateTest();
    try {
      const key = await file.text();
      if (version === fileVersion.current) set('privateKey', key);
    } catch {
      if (version === fileVersion.current) {
        setKeyError('키 파일을 읽을 수 없습니다. 파일을 다시 선택하세요.');
        setReadingKey(false);
      }
    }
  };

  return (
    <>
      <Modal title={editing ? '서버 설정' : '서버 등록'} onClose={close} initialFocus={nameInput} closeDisabled={saving}>
        <form onSubmit={save} className="form">
          {!editing && (
            <ol className="registration-steps" aria-label="서버 등록 단계">
              {['접속 정보 입력', '접속 테스트', '호스트 키 확인', '등록'].map((label, index) => (
                <li key={label} aria-current={step === index ? 'step' : undefined}>{index + 1}. {label}</li>
              ))}
            </ol>
          )}
          <label className="field">
            <span>이름 <small className="field-required" aria-hidden="true">필수</small></span>
            <input ref={nameInput} value={form.name} onChange={(e) => set('name', e.target.value)}
              placeholder="예: 웹 서버" required disabled={saving} />
            {form.name.trim().length > 100 && <small className="error-text">이름을 100자 이내로 입력하세요.</small>}
          </label>
          <div className="field">
            <label htmlFor="server-tags" className="server-field-label">태그 (선택)</label>
            <TagInput value={form.tags} onChange={(tags) => set('tags', tags)} suggestions={tagSuggestions}
              colors={live.settings?.tagColors} text={tagText} onTextChange={setTagText} disabled={saving} />
            <small id="server-tags-hint">서버를 묶는 태그입니다. Enter나 쉼표로 추가할 수 있습니다.</small>
          </div>
          <div className="row server-address-row">
            <label className="field grow">
              <span>주소 <small className="field-required" aria-hidden="true">필수</small></span>
              <input value={form.host} onChange={(e) => set('host', e.target.value)}
                placeholder="192.0.2.10 또는 host.example.com" required disabled={saving} />
            </label>
            <label className="field port">
              <span>포트 <small className="field-required" aria-hidden="true">필수</small></span>
              <input type="number" min={1} max={65535} step={1} value={portText} required disabled={saving}
                aria-label="포트" aria-invalid={!validPort} aria-describedby="server-port-hint"
                onChange={(event) => {
                  setPortText(event.target.value);
                  setError(null);
                  invalidateTest();
                }} />
              <small id="server-port-hint" className={validPort ? undefined : 'server-field-error'}>
                {validPort ? '1~65535' : '1~65535 사이의 정수를 입력하세요.'}
              </small>
            </label>
          </div>
          <label className="field">
            <span>계정 <small className="field-required" aria-hidden="true">필수</small></span>
            <input value={form.user} onChange={(e) => set('user', e.target.value)} autoComplete="off" required disabled={saving} />
          </label>
          <div className="field">
            <span>인증 방식</span>
            <div className="segmented">
              <button type="button" className={form.authType === 'password' ? 'active' : ''} disabled={saving}
                aria-pressed={form.authType === 'password'} onClick={() => form.authType !== 'password' && set('authType', 'password')}>
                비밀번호
              </button>
              <button type="button" className={form.authType === 'key' ? 'active' : ''} disabled={saving}
                aria-pressed={form.authType === 'key'} onClick={() => form.authType !== 'key' && set('authType', 'key')}>
                개인 키
              </button>
            </div>
          </div>
          {form.authType === 'password' ? (
            <label className="field">
              <span>비밀번호 {!storedAuth && <small className="field-required" aria-hidden="true">필수</small>}</span>
              <input
                type="password"
                value={form.password}
                onChange={(e) => set('password', e.target.value)}
                autoComplete="new-password"
                placeholder={storedAuth ? '바꾸지 않으려면 비워 두세요' : ''}
                required={!storedAuth}
                disabled={saving}
              />
            </label>
          ) : (
            <>
              <div className="field">
                <div className="row server-key-row">
                  <label htmlFor="server-private-key" className="server-field-label">
                    개인 키 {!storedAuth && <small className="field-required" aria-hidden="true">필수</small>}
                  </label>
                  <button type="button" className="button ghost" onClick={() => keyFile.current?.click()} disabled={saving}>
                    키 파일 선택
                  </button>
                  <input ref={keyFile} type="file" hidden onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = '';
                    void loadKeyFile(file);
                  }} />
                </div>
                <textarea
                  id="server-private-key"
                  rows={4}
                  value={form.privateKey}
                  onChange={(e) => set('privateKey', e.target.value)}
                  placeholder={
                    storedAuth
                      ? '바꾸지 않으려면 비워 두세요'
                      : '-----BEGIN OPENSSH PRIVATE KEY----- 형식의 키를 붙여 넣으세요'
                  }
                  spellCheck={false}
                  required={!storedAuth}
                  disabled={saving}
                  aria-describedby="server-key-hint"
                />
                <small id="server-key-hint">개인 키를 붙여 넣거나 키 파일을 선택하세요.</small>
                {keyError && <small className="server-field-error" role="alert">{keyError}</small>}
              </div>
              <label className="field">
                <span>개인 키 암호 (있을 때만)</span>
                <input type="password" value={form.passphrase} onChange={(e) => set('passphrase', e.target.value)}
                  autoComplete="new-password" disabled={saving} />
              </label>
            </>
          )}

          <div className="test-box">
            <button type="button" className="button" onClick={runTest} disabled={!canTest}>
              {test.kind === 'running' ? '접속하는 중…' : '접속 테스트'}
            </button>
            {test.kind === 'idle' && (
              <p className="hint" role="status">
                {readingKey ? '키 파일을 읽는 중…'
                  : missing.length ? `접속 테스트에 필요한 항목: ${missing.join(', ')}`
                  : connectionUnchanged ? '접속 정보를 바꾸지 않았다면 바로 저장할 수 있습니다.'
                  : '접속 테스트를 실행한 뒤 호스트 키 지문을 확인하세요.'}
              </p>
            )}
            {test.kind === 'error' && <p className="error-text" role="alert">접속 테스트 실패 · {test.message}</p>}
            {test.kind === 'ok' && (
              <div className="test-result">
                <p className="ok-text">
                  접속 성공 · 메모리 {test.memory?.toFixed(1) ?? '–'}% · 디스크 {test.disk ?? '–'}%
                </p>
                <p className="fingerprint">
                  호스트 키 지문 <code>SHA256:{test.fingerprint}</code>
                </p>
                {fingerprintChanged && (
                  <p className="warn-text">⚠ 저장된 지문(SHA256:{server!.fingerprint})과 다릅니다. 서버를 다시 설치했거나 주소를 바꾼 경우에만 진행하세요.</p>
                )}
                <label className="check">
                  <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} disabled={saving} />
                  이 지문이 접속하려는 서버의 호스트 키가 맞습니다
                </label>
              </div>
            )}
          </div>

          {error && <p className="error-text">{error}</p>}
          <footer className="server-form-footer">
            <span className="hint" role="status">
              {!validName ? '이름을 1~100자로 입력하세요.'
                : fingerprint && !trusted ? '등록 또는 저장하려면 호스트 키 지문을 확인하세요.'
                : !canSave && !saving ? '접속 테스트를 완료하면 진행할 수 있습니다.' : ''}
            </span>
            <button type="button" className="button ghost" onClick={close} disabled={saving}>
              취소
            </button>
            <button type="submit" className="button primary" disabled={!canSave || saving}>
              {saving ? '저장하는 중…' : editing ? '저장' : '등록'}
            </button>
          </footer>
        </form>
      </Modal>
      {discard && (
        <Modal title="작성 중인 내용이 있습니다" onClose={() => setDiscard(false)} initialFocus={keepEditingButton}>
          <div className="form">
            <p>창을 닫으면 입력한 내용이 사라집니다.</p>
            <footer>
              <button ref={keepEditingButton} className="button ghost" onClick={() => setDiscard(false)}>계속 작성</button>
              <button className="button danger" onClick={onClose}>작성 내용 버리기</button>
            </footer>
          </div>
        </Modal>
      )}
    </>
  );
}

/** 데스크톱 앱에서 내보낸 .rmon 파일을 가져온다. */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.importRmon(file, password);
      await refreshServers();
      toast(`서버 ${result.added}대를 가져왔습니다.${result.skipped ? ` 이미 등록된 ${result.skipped}대는 건너뛰었습니다.` : ''}`);
      onClose();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="서버 가져오기" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <p className="hint">데스크톱 리소스 모니터의 <b>내보내기</b>로 만든 <code>.rmon</code> 파일과 공유 암호를 입력하세요.</p>
        <label className="field">
          <span>파일</span>
          <input type="file" accept=".rmon" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        </label>
        <label className="field">
          <span>공유 암호</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="off" />
        </label>
        {error && <p className="error-text">{error}</p>}
        <footer>
          <button type="button" className="button ghost" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="button primary" disabled={!file || !password || busy}>
            {busy ? '가져오는 중…' : '가져오기'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
