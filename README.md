# 리소스 모니터 (웹)

SSH로 리눅스 서버의 CPU, 메모리, 디스크 용량, 디스크 입출력을 모아 팀이 브라우저로 함께 보는 웹 앱입니다.
데스크톱 앱(`resource-monitor`, WPF)을 팀 공용 서버용으로 옮겼습니다.

## 데스크톱 앱과 달라진 점

| 데스크톱 앱 | 웹 |
| --- | --- |
| 앱이 켜져 있고 **기록 시작**을 눌렀을 때만 기록 | 등록된 서버를 **항상** 수집·기록하고, 보관 기간(기본 30일)이 지나면 자동으로 정리 |
| 서버를 한 대씩 확인 | **전체 현황**에서 모든 서버의 상태와 현재 값을 한눈에 확인. 문제 있는 서버만 따로 볼 수 있음 |
| 비교는 최대 3대 | **비교** 화면에서 서버 수 제한 없이 같은 지표를 겹쳐 봄 |
| 과거 조회는 시·분·초 콤보 6개로 입력 | 15분·1시간·6시간·24시간·7일·30일 빠른 선택, 사용자 지정 기간, **그래프 드래그 확대** |
| 서버 설정은 `.rmon` 파일과 암호를 따로 전달 | 같은 주소에 접속하기만 하면 됨. 화면 상태(서버·범위·지표)가 URL에 남아 **링크로 공유** 가능 |
| – | 경고 기준(CPU·메모리·디스크) 색상 표시와 그래프 점선, CSV 내려받기, 수집 켜기/끄기 |

기존 `.rmon` 파일은 **가져오기**로 그대로 등록할 수 있습니다.

## 실행 (Docker)

같은 폴더에 `.env`를 만들어 실행 사용자와 포트를 정합니다.

```bash
printf "APP_UID=%s\nAPP_GID=%s\nHOST_PORT=18080\n" $(id -u) $(id -g) > .env
mkdir -p storage
docker compose up -d --build
```

`http://<서버 주소>:<HOST_PORT>`로 접속합니다. 데이터는 compose 파일 옆의 `./storage` 폴더(컨테이너의 `/data`)에 저장됩니다.

- `monitor.db`: 서버 목록, 수집 지표, 설정 (SQLite)
- `keys/`: SSH 비밀번호·개인 키를 암호화하는 키 (ASP.NET Data Protection)

**두 항목은 함께 백업해야 합니다.** `keys/`를 잃으면 저장된 SSH 비밀번호를 풀 수 없어 서버마다 다시 입력해야 합니다.

## 보안 주의

로그인 없이 운영하도록 만들었습니다. 접속할 수 있는 사람은 누구나 서버를 등록·수정·삭제하고 설정을 바꿀 수 있습니다.

- 사내망이나 VPN 안에서만 열고, 인터넷에 직접 노출하지 마세요.
- API는 저장된 비밀번호와 개인 키를 **응답으로 돌려주지 않습니다.** 다만 웹 서버가 모니터링 대상에 SSH로 접속할 수 있으므로, 대상 서버에는 조회 전용 계정을 쓰는 것을 권장합니다.
- HTTPS가 필요하면 앞단에 리버스 프록시(nginx 등)를 두세요. SSE(`/api/events`)를 쓰므로 프록시 버퍼링을 꺼야 합니다(`proxy_buffering off;`).

## 개발

필요한 도구: .NET 8 SDK, Node.js 20 이상

```bash
cd backend && dotnet run          # http://localhost:5080
cd frontend && npm install && npm run dev   # http://localhost:5173 (/api는 5080으로 프록시)
```

프런트엔드를 백엔드에 넣어 함께 실행하려면 `cd frontend && npm run build`로 `backend/wwwroot`에 빌드한 뒤 `dotnet run`만 실행합니다.

## 구조

```
backend/   ASP.NET Core 8 (minimal API)
  Monitoring/SshCollector.cs   SSH로 /proc·/sys·df를 읽어 지표 계산 (데스크톱 앱 SshMonitor 이식)
  Monitoring/MonitorService.cs 서버마다 수집 루프 실행, 보관 기간 정리
  Monitoring/LiveState.cs      현재 상태·최신 값, SSE로 전파
  Data/*.cs                    SQLite 저장소
  Import/RmonImporter.cs       데스크톱 앱 .rmon 가져오기
frontend/  React + Vite + uPlot
```

### API 요약

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/servers` | 서버 목록과 현재 상태 |
| POST / PUT / DELETE | `/api/servers[/{id}]` | 서버 등록·수정·삭제 (삭제하면 기록도 함께 삭제) |
| POST | `/api/servers/test` | 접속 테스트, 호스트 키 지문 확인 |
| POST | `/api/servers/{id}/enabled` | 수집 켜기/끄기 |
| POST | `/api/servers/import` | `.rmon` 가져오기 (multipart: `file`, `password`) |
| GET | `/api/servers/{id}/samples?from&to&points` | 기간 지표 (ms, 구간 평균으로 줄여서 반환) |
| GET | `/api/servers/{id}/samples.csv?from&to` | 원본 지표 CSV |
| GET | `/api/samples/recent?minutes` | 전체 서버 최근 추이 |
| GET / PUT | `/api/settings` | 갱신 주기, 보관 기간, 경고 기준 |
| GET | `/api/events` | SSE: `sample`, `status`, `servers`, `settings` |
