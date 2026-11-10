import { createContext, useContext, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { allTags, Server } from './api';
import { StatusDot, TagFilter, Toasts } from './components/Common';
import { deleteServerWithConfirm, ImportDialog, ServerDialog } from './components/Dialogs';
import { useLive } from './live';
import Compare from './pages/Compare';
import Overview from './pages/Overview';
import ServerDetail from './pages/ServerDetail';
import SettingsPage from './pages/SettingsPage';

type DialogState = { kind: 'server'; server?: Server } | { kind: 'import' } | null;

const DialogContext = createContext<{ openServer: (server?: Server) => void; openImport: () => void }>({
  openServer: () => {},
  openImport: () => {},
});

export const useDialogs = () => useContext(DialogContext);

export default function App() {
  const live = useLive();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [filter, setFilter] = useState('');
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('sidebar-collapsed') === '1';
    } catch {
      return false;
    }
  });
  const toggleSidebar = (value: boolean) => {
    setCollapsed(value);
    try {
      localStorage.setItem('sidebar-collapsed', value ? '1' : '0');
    } catch {
      /* 저장할 수 없으면 이번 화면에서만 유지한다. */
    }
  };
  const [tag, setTag] = useState<string | null>(null);
  const tags = allTags(live.servers);
  const servers = live.servers.filter(
    (server) =>
      `${server.name} ${server.host}`.toLowerCase().includes(filter.trim().toLowerCase()) &&
      (!tag || !tags.includes(tag) || server.tags.includes(tag)),
  );

  return (
    <DialogContext.Provider
      value={{ openServer: (server) => setDialog({ kind: 'server', server }), openImport: () => setDialog({ kind: 'import' }) }}
    >
      <div className={`layout ${collapsed ? 'collapsed' : ''}`}>
        {collapsed && (
          <button className="sidebar-open" onClick={() => toggleSidebar(false)} title="사이드바 열기" aria-label="사이드바 열기">
            ☰
          </button>
        )}
        <aside className="sidebar" hidden={collapsed}>
          <div className="brand">
            <Link to="/" className="brand-link" aria-label="리소스 모니터 전체 현황">
              <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
                <polyline points="5,22 11,15 16,19 22,9 27,13" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              리소스 모니터
            </Link>
            <button className="icon-button sidebar-close" onClick={() => toggleSidebar(true)} title="사이드바 닫기" aria-label="사이드바 닫기">
              «
            </button>
          </div>
          <nav className="nav">
            <NavLink to="/" end>전체 현황</NavLink>
            <NavLink to="/compare">비교</NavLink>
            <NavLink to="/settings">설정</NavLink>
          </nav>
          <div className="sidebar-actions">
            <button className="button primary" onClick={() => setDialog({ kind: 'server' })}>
              + 서버 등록
            </button>
            <button className="button ghost" onClick={() => setDialog({ kind: 'import' })}>
              가져오기
            </button>
          </div>
          <div className="server-list-header">
            <span>
              {servers.length === live.servers.length
                ? `서버 ${live.servers.length}대`
                : `서버 ${live.servers.length}대 중 ${servers.length}대 표시`}
            </span>
          </div>
          {tags.length > 0 && (
            <div className="sidebar-filter">
              <span className="hint">목록 필터</span>
              <TagFilter tags={tags} colors={live.settings?.tagColors} value={tag && tags.includes(tag) ? tag : null} onChange={setTag} />
            </div>
          )}
          {live.servers.length > 6 && (
            <input className="search" placeholder="이름·주소 검색" value={filter} onChange={(e) => setFilter(e.target.value)} />
          )}
          <ul className="server-list">
            {servers.map((server) => (
              <li key={server.id}>
                <NavLink to={`/servers/${server.id}`} title={server.error ?? undefined}>
                  <StatusDot status={server.status} />
                  <span className="server-name">{server.name}</span>
                  <span className="server-host">{server.host}</span>
                </NavLink>
                <div className="item-actions">
                  <button className="icon-button" title="서버 설정" aria-label={`${server.name} 설정`} onClick={() => setDialog({ kind: 'server', server })}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                      <path d="M4 6h7m4 0h5M4 12h3m4 0h9M4 18h10m4 0h2" />
                      <circle cx="13" cy="6" r="2" />
                      <circle cx="9" cy="12" r="2" />
                      <circle cx="16" cy="18" r="2" />
                    </svg>
                  </button>
                  <button
                    className="icon-button danger"
                    title="서버 삭제"
                    aria-label={`${server.name} 삭제`}
                    onClick={async () => {
                      if ((await deleteServerWithConfirm(server)) && location.pathname.includes(server.id)) navigate('/');
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M10 11v5m4-5v5" />
                    </svg>
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className={`connection ${live.connected ? 'on' : 'off'}`}>
            {live.connected ? '● 실시간 연결됨' : '○ 서버와 연결이 끊겼습니다. 다시 연결하는 중…'}
          </div>
        </aside>
        <main className="content">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/servers/:id" element={<ServerDetail />} />
            <Route path="/compare" element={<Compare />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Overview />} />
          </Routes>
        </main>
      </div>
      {dialog?.kind === 'server' && (
        <ServerDialog
          server={dialog.server}
          onClose={() => setDialog(null)}
          onSaved={(saved) => !dialog.server && navigate(`/servers/${saved.id}`)}
        />
      )}
      {dialog?.kind === 'import' && <ImportDialog onClose={() => setDialog(null)} />}
      <Toasts />
    </DialogContext.Provider>
  );
}
