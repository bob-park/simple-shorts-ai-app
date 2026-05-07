# Simple Shorts AI App — 설계 문서

- 작성일: 2026-05-07
- 상태: 브레인스토밍 완료, 구현 전 검토 단계
- 대상 플랫폼: macOS (Apple Silicon + Intel), Windows 10/11 x64

## 1. 목적

YouTube 영상 URL을 입력하면 영상을 다운로드하고, 로컬에서 음성을 텍스트로 변환(STT)한 뒤, LLM이 자동으로 하이라이트를 골라 9:16 비율의 숏츠 영상으로 만들어 주는 데스크톱 앱을 만든다. 사용자는 URL을 붙여넣고 옵션을 선택하기만 하면 되고, 모델 선택·경로·자막 스타일 같은 설정은 한 번만 해 두면 된다.

## 2. 핵심 결정사항 요약 (브레인스토밍 합의)

| 항목               | 결정                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------- |
| 추출 방식          | **완전 자동** — AI가 하이라이트 자동 선정                                                |
| 앱 형태            | **Electron + React** (TypeScript), MiniMax 디자인 시스템                                 |
| 9:16 변환          | **스마트 페이스 트래킹 크롭** (MediaPipe)                                                |
| 자막               | **자동 자막 burn-in + 스타일링** (Whisper word-level timing)                             |
| 숏츠 개수/길이     | **사용자 설정 가능** (개수 1~10, 길이 범위 슬라이더)                                     |
| STT 엔진           | **Python 사이드카 + faster-whisper**                                                     |
| Python ↔ Node 통신 | **장기 실행 Python 서버 + JSON-RPC stdio**                                               |
| API 키/모델        | **사용자가 설정 화면에 OpenRouter API 키 입력 + 모델 선택**, 키는 OS 키체인(keytar) 저장 |
| 부가 기능          | URL 미리보기 / 작업 진행도 / 결과 재생 / 히스토리 (리스트·썸네일 토글 + 검색)            |

## 3. 시스템 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│  Electron App                                               │
│                                                             │
│  ┌───────────────────────┐    ┌───────────────────────┐     │
│  │  Renderer (React)     │    │  Main Process (Node)  │     │
│  │  - 화면/UI            │◄──►│  - Job 오케스트레이션 │     │
│  │  - MiniMax 디자인     │IPC │  - 파일/설정/DB 관리  │     │
│  │  - 진행도 구독        │    │  - yt-dlp / ffmpeg    │     │
│  └───────────────────────┘    │  - OpenRouter SDK     │     │
│                                │  - Keychain (API key) │     │
│                                └──────────┬────────────┘     │
│                                           │ JSON-RPC stdio   │
│                                ┌──────────▼────────────┐     │
│                                │  Python Sidecar       │     │
│                                │  - faster-whisper     │     │
│                                │  - MediaPipe Face     │     │
│                                │  (장기 실행, 모델 hot)│     │
│                                └───────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
                  │
                  ▼  로컬 파일시스템
   다운로드 폴더 / 작업 폴더 / SQLite (히스토리/설정)
```

### 3.1 책임 분리

- **Renderer** = 순수 UI. 비즈니스 로직 없음. IPC 채널로 Main에 일을 시키고 진행도/결과 이벤트를 구독.
- **Main Process** = 파이프라인 오케스트레이터. 외부 도구(yt-dlp, ffmpeg, OpenRouter) 호출, Python sidecar 라이프사이클 관리, SQLite·설정·키체인 영속화.
- **Python Sidecar** = ML 전담. STT(faster-whisper)와 페이스 트래킹(MediaPipe)만. 다른 책임 없음. 죽으면 Main이 자동으로 재시작.

이 경계는 다음 두 원칙을 따른다:

1. **모델은 한 번만 로딩한다.** 무거운 모델 가중치를 매 작업마다 다시 올리지 않도록 사이드카는 장기 실행한다.
2. **외부 도구는 한 곳에만 둔다.** yt-dlp/ffmpeg는 Main에만, ML은 Sidecar에만. 양쪽이 같은 외부 도구를 호출하지 않는다.

## 4. 컴포넌트 분해

### 4.1 화면 구성 (React Renderer)

```
┌──────────┬─────────────────────────────────────────────┐
│ Sidebar  │                                             │
│          │                                             │
│ ▸ 새작업 │   메인 컨텐츠 영역                          │
│ ▸ 작업중 │                                             │
│ ▸ 히스토리│                                             │
│ ▸ 설정   │                                             │
│          │                                             │
└──────────┴─────────────────────────────────────────────┘
```

| 화면         | 핵심 요소                                                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NewJob**   | URL 입력 pill, 미리보기 카드(YouTube 썸네일 + 메타), 옵션 패널(숏츠 개수/길이 슬라이더), 검정 pill "분석 시작" 버튼                                                                                        |
| **Progress** | 단계별 스테퍼(다운로드 → STT → 하이라이트 → 렌더), 진행률 바, 라이브 로그 콘솔(접기 가능), 취소 버튼                                                                                                       |
| **Result**   | 생성된 숏츠를 vibrant gradient `product-card` 그리드(2~3열)로 표시. hover시 자동재생 미리보기. "저장" / "다른 이름으로" / "다시 만들기" 액션                                                               |
| **History**  | **상단**: 검색 pill + 정렬(최신/제목/길이) + 뷰 토글(리스트/썸네일). **본문**: 썸네일 모드는 4열 카드 그리드(`ai-product-tile` 스타일), 리스트 모드는 `data-table` 스타일. 항목 클릭시 결과 화면으로 이동. |
| **Settings** | 섹션별 카드(`card-base`): API & 모델 / 경로 / Whisper 모델 / 자막 스타일 / 출력 옵션                                                                                                                       |

디자인은 MiniMax 가이드(black pill 버튼, DM Sans, 32px 라운드 vibrant gradient 카드 + 16px 라운드 white 카드 대비)를 따른다.

### 4.2 Main Process 모듈 (Node.js)

```
src/main/
├── ipc/
│   └── handlers.ts             # Renderer↔Main 계약(zod 스키마 공유)
├── orchestrator/
│   └── JobOrchestrator.ts      # 단계별 파이프라인 + 진행도 emit
├── services/
│   ├── YouTubeService.ts       # yt-dlp 래퍼 (메타 / 다운로드)
│   ├── TranscribeService.ts    # Python sidecar 클라이언트
│   ├── HighlightService.ts     # OpenRouter SDK 호출 + 프롬프트
│   ├── VideoEditService.ts     # ffmpeg 합성 (cut · 9:16 · 자막)
│   └── ThumbnailService.ts     # 결과/소스 썸네일 추출
├── infra/
│   ├── PythonSidecar.ts        # 프로세스 라이프사이클 + RPC
│   ├── HistoryRepo.ts          # SQLite (better-sqlite3)
│   ├── SettingsStore.ts        # electron-store (JSON)
│   └── KeychainService.ts      # keytar (OS 키체인)
└── main.ts                     # 부트스트랩
```

각 모듈은 단일 책임 + 명확한 인터페이스를 갖는다. 외부 도구 의존(yt-dlp, ffmpeg, OpenRouter)은 services 레이어 밖으로 새지 않는다.

### 4.3 Python Sidecar 모듈

```
sidecar/
├── rpc_server.py        # stdio JSON-RPC (line-delimited)
├── whisper_engine.py    # faster-whisper 래퍼, word-level timestamps
├── face_tracker.py      # MediaPipe Face Detection + 가우시안 스무딩
└── main.py              # RPC method 등록 + 모델 lazy-load
```

**Sidecar가 노출하는 RPC 메서드:**

- `transcribe(audio_path, model, language?) → { segments[], words[] }`
- `track_faces(video_path, fps_sample?) → { frames: [{ t, cx, cy }] }`
- `health() → { ok, models_loaded }`
- `cancel(token)` — 진행중 작업 중단 협조

## 5. 데이터 흐름 (영상 처리 파이프라인)

### 5.1 트리거 → 백그라운드 잡

```
[Renderer]                          [Main]                             [Python Sidecar]
    │                                  │                                      │
    │  ipc.fetchPreview(url)           │                                      │
    ├─────────────────────────────────►│                                      │
    │                                  │  yt-dlp --dump-json                  │
    │                                  ├──► (외부 프로세스)                   │
    │  preview { title, thumb, dur }   │                                      │
    │◄─────────────────────────────────┤                                      │
    │                                  │                                      │
    │  ipc.startJob({url, opts})       │                                      │
    ├─────────────────────────────────►│  jobId 반환 + 단계별 emit 시작       │
    │                                  │                                      │
    │  on('job:progress', jobId)       │                                      │
    │◄═════════════════════════════════│════════════════════════════ 구독     │
    │                                  │                                      │
    │                                  │  ① download (yt-dlp)                 │
    │                                  │  ② transcribe ──RPC ─────────────►   │
    │                                  │     ◄── { segments, words } ─────┤  │
    │                                  │  ③ extractHighlights (OpenRouter)│  │
    │                                  │  ④ for each hl:                  │  │
    │                                  │     - cut (ffmpeg)               │  │
    │                                  │     - track_faces ──RPC ─────────►│  │
    │                                  │     ◄── { frames } ──────────────┤  │
    │                                  │     - render 9:16 + 자막         │  │
    │                                  │  ⑤ save thumbnails + DB row      │  │
    │  on('job:done', { shorts[] })    │                                      │
    │◄─────────────────────────────────┤                                      │
```

### 5.2 단계별 상세

| #   | 단계            | 입력                                    | 출력                                          | 도구                          |
| --- | --------------- | --------------------------------------- | --------------------------------------------- | ----------------------------- |
| ①   | Download        | URL, 작업 폴더                          | `source.mp4` (h264/aac 선호)                  | yt-dlp (`-f bv*+ba/b`)        |
| ②   | Transcribe      | `audio.wav` (16kHz mono로 추출 후 전달) | `{ segments[], words[{ text, start, end }] }` | faster-whisper                |
| ③   | Highlights      | words[] + 옵션(개수, 길이 범위)         | `[{ start_sec, end_sec, title, hook }]`       | OpenRouter SDK + 구조화 응답  |
| ④   | Per-clip render | 원본 + (start,end) + faces[]            | `short_N.mp4` (1080×1920, h264, AAC)          | ffmpeg + Python 트래킹 데이터 |
| ⑤   | Persist         | shorts[] + 메타                         | History row + 썸네일 PNG                      | SQLite + ffmpeg thumbnail     |

### 5.3 LLM 프롬프트와 응답 계약

```
시스템 프롬프트 (요약):
  "당신은 짧은 영상 편집자다. 아래 단어 단위 타임스탬프 트랜스크립트를
   분석해서 시청자를 끌어당길 N개의 하이라이트를 골라라.
   각 하이라이트는 X초 ~ Y초 사이. 응답은 JSON 스키마를 정확히 따른다."

응답 스키마:
  { highlights: [
      { start_sec: number, end_sec: number, title: string, hook: string }
  ] }
```

- OpenRouter의 JSON 응답 모드(또는 tool call)를 사용해 구조화 응답을 강제한다.
- 검증 실패시 1회 재시도(temperature ↓, "valid JSON only" 강조). 두 번째 실패시 사용자에게 모델 변경을 권고하는 모달.
- 트랜스크립트가 LLM 컨텍스트를 넘으면 단어 수 기준 슬라이딩 윈도우(예: 15분 단위)로 청크별 후보를 뽑고, 마지막에 한 번 더 호출해 최종 N개를 선정한다.

### 5.4 9:16 렌더링 전략

**선택: Python 사이드카가 트래킹 데이터를 시간축 키프레임 시퀀스로 평활화해서 반환 → Main이 ffmpeg에 `sendcmd`로 동적 crop 명령을 주입.**

```
sidecar.track_faces() returns:
  [
    { t: 0.0,  cx: 0.51, cy: 0.42 },     # 0.5초 간격 샘플 + 가우시안 스무딩
    { t: 0.5,  cx: 0.52, cy: 0.43 },
    ...
  ]

→ ffmpeg sendcmd 파일 생성 + 단일 패스:
  crop=w=ih*9/16:h=ih → scale=1080:1920 → subtitles=auto.ass → out.mp4
```

폴백: 얼굴 미검출 구간은 마지막 유효 좌표 유지, 전체 클립에서 트래킹 0개면 중앙 크롭으로 폴백 + 사용자 토스트.

## 6. 데이터 모델

### 6.1 SQLite 스키마

```sql
-- 작업 단위 (한 YouTube URL → 하나의 job)
CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,            -- ulid
  url             TEXT NOT NULL,
  video_id        TEXT NOT NULL,
  title           TEXT NOT NULL,
  channel         TEXT,
  duration_sec    INTEGER,
  source_path     TEXT,
  source_thumb    TEXT,
  status          TEXT NOT NULL,               -- 'queued'|'running'|'done'|'partial_done'|'failed'|'canceled'
  error_message   TEXT,
  options_json    TEXT NOT NULL,
  llm_model       TEXT,
  whisper_model   TEXT,
  created_at      INTEGER NOT NULL,
  finished_at     INTEGER
);

CREATE INDEX idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX idx_jobs_status  ON jobs(status);
CREATE INDEX idx_jobs_video   ON jobs(video_id);

CREATE TABLE shorts (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  idx             INTEGER NOT NULL,
  title           TEXT NOT NULL,
  hook            TEXT,
  start_sec       REAL NOT NULL,
  end_sec         REAL NOT NULL,
  output_path     TEXT NOT NULL,
  thumb_path      TEXT,
  width           INTEGER,
  height          INTEGER,
  size_bytes      INTEGER
);

CREATE INDEX idx_shorts_job ON shorts(job_id);

-- 전문 검색 (제목/채널/숏츠 제목 통합)
CREATE VIRTUAL TABLE search_idx USING fts5(
  job_id UNINDEXED,
  title, channel, short_titles, hooks,
  tokenize = 'unicode61 remove_diacritics 2'
);
-- jobs/shorts 변경 트리거로 자동 동기화
```

### 6.2 설정 스토어 (electron-store JSON)

```typescript
interface Settings {
  paths: {
    downloads: string; // 원본 영상 저장 위치
    workspace: string; // 작업 임시 폴더
    outputs: string; // 완성된 숏츠 저장 위치
  };
  llm: {
    provider: 'openrouter';
    model: string; // 예: 'anthropic/claude-sonnet-4.5'
  };
  whisper: {
    model: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';
    language: 'auto' | 'ko' | 'en';
    device: 'auto' | 'cpu' | 'cuda' | 'metal';
  };
  shorts: {
    defaultCount: number;
    minSec: number;
    maxSec: number;
  };
  subtitles: {
    enabled: boolean;
    fontFamily: string;
    fontSize: number;
    fillColor: string;
    outlineColor: string;
    position: 'bottom' | 'middle';
  };
  ui: {
    historyView: 'list' | 'thumbnails';
    theme: 'light';
  };
}
```

```
keytar:
  service: 'simple-shorts-ai-app'
  account: 'openrouter'
  secret:  '<API key>'
```

### 6.3 파일시스템 레이아웃

```
<App Data>/                       # OS 표준 위치 (electron app.getPath('userData'))
├── config.json
├── history.db
├── thumbs/
│   ├── <jobId>_source.png
│   └── <shortId>.png
└── logs/

<사용자 지정 workspace>/<jobId>/  # 작업 임시 폴더
├── source.mp4
├── audio.wav
├── transcript.json
├── highlights.json
├── tracks/
│   └── short_1.track.json
├── subtitles/
│   └── short_1.ass
└── work_logs/

<사용자 지정 outputs>/
└── <YYYY-MM-DD>_<videoTitle_slug>/
    ├── short_1.mp4
    └── ...
```

정리 정책: 설정에 "작업 완료 후 임시 파일 자동 삭제(기본 OFF)" 토글. 디버깅·재처리를 위해 기본 보존.

### 6.4 검색 UX

History 화면 검색창 → FTS5 쿼리 + 필터:

- 자유 텍스트: `search_idx MATCH ?`
- 정렬: 최신순 / 제목순 / 길이순
- 필터(접기): 날짜 범위, 상태, LLM 모델
- 뷰 토글: 리스트 (`data-table`) / 썸네일 (4열 `ai-product-tile` 그리드)

## 7. 에러 처리 + 엣지 케이스

### 7.1 실패 카테고리 매트릭스

| 카테고리           | 구체 케이스                     | 검출                                 | 사용자 노출                                 | 복구                                      |
| ------------------ | ------------------------------- | ------------------------------------ | ------------------------------------------- | ----------------------------------------- |
| **YouTube**        | 비공개/지역제한/연령제한/삭제됨 | yt-dlp exit + stderr 패턴            | "이 영상은 다운로드할 수 없습니다 — <사유>" | 메타 fetch에서 미리 차단                  |
|                    | 라이브 진행중                   | `is_live=true`                       | "라이브 종료 후 다시 시도"                  | 차단                                      |
|                    | 너무 긴 영상 (>3시간)           | 메타 duration                        | 경고 모달 "시간/디스크가 많이 필요합니다"   | 사용자 동의 후 진행                       |
|                    | 무성에 가까운 영상              | STT 결과 words.length 적음           | "음성을 거의 추출하지 못했습니다"           | 작업 실패                                 |
| **다운로드**       | yt-dlp 미설치/경로 오류         | spawn ENOENT                         | 셋업 위저드로 유도                          | 번들된 yt-dlp 사용                        |
|                    | 진행중 네트워크 끊김            | 30s 정체                             | 토스트 + 자동 재시도 1회                    | 재실패시 작업 실패                        |
|                    | 디스크 부족                     | 시작 전 freeSpace 체크               | 모달 "여유 공간 부족"                       | 차단                                      |
| **Python sidecar** | 시작 실패                       | spawn 실패                           | 첫 실행 화면에서 셋업 유도                  | 자동 설치 도우미                          |
|                    | 런타임 죽음                     | stdio EOF / exit                     | Main이 자동 재시작 1회                      | 다음 작업은 정상                          |
|                    | RPC 응답 hang                   | per-method timeout                   | 진행도 화면에 "응답 없음 — 재시작" 버튼     | 사용자 트리거 강제 재시작                 |
|                    | OOM                             | exit 137                             | "Whisper 모델이 너무 큽니다"                | 설정으로 유도                             |
| **STT**            | 모델 다운로드 실패              | HTTP 에러                            | 명확 메시지 + 재시도                        | 자동 재시도 3회 (지수 백오프)             |
|                    | 언어 감지 신뢰도 낮음           | 신뢰도 임계                          | 토스트 "감지된 언어: X (수정 가능)"         | 설정에서 수동                             |
| **LLM**            | API 키 무효 (401)               | HTTP 401                             | 모달 + 설정 직링크                          | 사용자 수정                               |
|                    | 레이트리밋 (429)                | HTTP 429 + Retry-After               | 자동 백오프 후 재시도                       | 실패시 명확 메시지                        |
|                    | JSON 파싱 실패                  | 스키마 검증 실패                     | 자동 재시도 1회                             | 실패시 모델 변경 권고                     |
|                    | 컨텍스트 초과                   | 토큰 사전 추정                       | 슬라이딩 윈도우 모드 자동 전환              | 사용자에게 알림                           |
| **렌더링**         | ffmpeg 실패 (코덱/필터)         | exit code                            | "이 클립을 렌더링하지 못했습니다"           | 부분 성공 허용, 다른 클립 계속            |
|                    | 페이스 트래킹 0개               | track 결과 비어있음                  | 토스트 "얼굴 감지 실패 — 중앙 크롭 사용"    | 자동 폴백                                 |
| **사용자 액션**    | 작업 취소                       | UI 버튼 → orchestrator.cancel(jobId) | "취소됨" 상태                               | 자식 프로세스 SIGTERM, sidecar cancel RPC |
|                    | 앱 종료 중 작업                 | beforeUnload                         | 모달 "작업 X개 진행중 — 정말 종료?"         | 사용자 선택                               |

### 7.2 가시성 원칙

- **단계 단위 격리**: 한 숏츠 렌더 실패가 전체 잡을 죽이지 않음. `partial_done` 상태 + 결과 화면에 실패 카드 표시.
- **사용자 액션 가능 여부 표시**: 모든 에러 메시지에 "무엇이 잘못됐는가" + "지금 할 수 있는 일" 두 줄로. 스택 트레이스 노출 금지.
- **로그 보존**: `<App Data>/logs/<jobId>.log` 에 모든 외부 프로세스 stderr + RPC 메시지. 결과 화면에 "로그 열기" 링크.
- **잡 상태 = 진실 한 곳**: SQLite의 `jobs.status` + `error_message`가 단일 진실. UI는 이를 구독.

### 7.3 첫 실행 셋업 가드

다음이 모두 준비되어야 작업 시작 가능:

1. OpenRouter API 키 (keytar)
2. Python sidecar 환경 (Python 3.10+ + 의존성 설치 완료)
3. 저장 경로 3종 (다운로드 / 작업 / 출력) — 기본값 자동 생성, 변경 가능
4. Whisper 모델 다운로드 (선택한 모델이 캐시되어 있어야 함)

NewJob 화면 진입시 준비도 체크리스트 카드 표시, 미준비 항목은 "지금 설정" 직링크. 모두 OK일 때만 URL 입력 활성화.

**Python 환경 번들 전략 (v1의 큰 위험):**

- macOS/Windows에 앱이 자체 Python 런타임을 번들 (PyInstaller로 sidecar 실행파일 생성, 또는 mini-distribution)
- 모델 가중치는 첫 사용시 다운로드 (앱 크기 절감)
- 진행률 시각화: 첫 실행 셋업 위저드에서 "환경 준비 중 (1/3)" 식으로 명확히

## 8. 테스트 전략 + 빌드 순서

### 8.1 테스트 계층

| 계층               | 대상                                                               | 도구                         | 보장                                                      |
| ------------------ | ------------------------------------------------------------------ | ---------------------------- | --------------------------------------------------------- |
| 단위               | services 모듈, orchestrator 상태기계, 프롬프트 빌더, 트래킹 스무더 | Vitest / pytest              | 외부 도구 mock — 입출력 계약, 에러 분기, 진행률 emit 순서 |
| 계약               | IPC 핸들러 / Main↔Sidecar JSON-RPC                                 | Vitest + zod                 | 양쪽이 같은 메시지 모양에 동의                            |
| 통합 (느림 OK)     | orchestrator + 진짜 yt-dlp/ffmpeg/whisper-tiny + 픽스처            | Vitest (CI nightly만)        | 파이프라인 end-to-end가 mp4를 만든다                      |
| E2E smoke          | 패키징된 앱 → 설정 → 짧은 영상 1개 처리 → 결과 보기                | Playwright + electron driver | 빌드 산출물이 켜지고 첫 작업이 굴러간다                   |
| 수동 QA 체크리스트 | 결과 미리보기, 히스토리 검색·뷰 토글, 취소, 에러 메시지            | 사람                         | UX 디테일                                                 |

**픽스처:** `fixtures/short_clip.mp4` (15초, 명확한 발화, 얼굴 1개). LLM 테스트는 OpenRouter mock 서버 + 1개 nightly 슈트만 진짜 호출. Whisper는 `tiny` 모델로만 테스트.

**테스트하지 않는 것:** ffmpeg 자체 정확성(외부 도구 신뢰), React 픽셀 perfect(시각 회귀는 v2).

### 8.2 빌드 순서 (시연 가능한 산출물 단위)

| #      | 마일스톤                      | 산출물                                                                                                      |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| M1     | 프로젝트 골격                 | Electron + React + Vite + TS, MiniMax 디자인 토큰 적용 빈 사이드바                                          |
| M2     | 설정 화면                     | 5개 설정 섹션 카드 동작, keytar 저장, 경로 다이얼로그                                                       |
| M3     | YouTube 미리보기 + 다운로드   | URL → 메타 카드 → 다운로드 단독 동작, 파일 재생 가능                                                        |
| M4     | Python sidecar + STT          | 사이드카 health 응답, transcript.json 생성, UI 진행률                                                       |
| M5     | LLM 하이라이트                | transcript → OpenRouter → highlights.json, 결과 mockup에 카드 표시                                          |
| **M6** | **첫 end-to-end (단순 모드)** | 위 + ffmpeg 클립 자르기 + 중앙 크롭 9:16 + 자막 없음 → 실제로 숏츠 mp4가 나온다. 작동하는 제품 첫 마일스톤. |
| M7     | 스마트 트래킹                 | MediaPipe + 스무딩 + ffmpeg sendcmd 동적 crop. M6 대비 시각 비교.                                           |
| M8     | 자막 burn-in                  | ASS 생성 + 스타일링 설정 적용                                                                               |
| M9     | 히스토리                      | SQLite + FTS5 + 리스트/썸네일 뷰 토글 + 검색 + 정렬/필터                                                    |
| M10    | 패키징 & 배포                 | macOS(.dmg, AS+Intel) / Windows(.exe), Python 사이드카 번들, 첫 실행 셋업 위저드                            |

**왜 이 순서:**

- M6에 "작동하는 못생긴 제품"을 빠르게 만들고 그 위에서 품질을 올린다 (스마트 트래킹·자막은 부가가치).
- Python 번들링·M10 같은 가장 위험한 부분은 dev 환경에서 동작이 검증된 뒤에야 의미 있음.
- M2(설정)를 일찍 두는 이유: 이후 모든 단계가 keytar 키와 경로에 의존.

### 8.3 구현 전 미리 검증할 위험 요소

1. **Python 사이드카 번들링** — 작은 PoC: 번들된 Python으로 faster-whisper가 macOS와 Windows에서 모두 모델 로드되는지.
2. **ffmpeg 동적 crop (sendcmd)** — 1시간 PoC: 단일 클립으로 sendcmd 동작 검증.
3. **OpenRouter JSON 모드 응답 안정성** — 다양한 모델(Claude/GPT/Gemini)에서 스키마 강제가 잘 되는지.
4. **MediaPipe 트래킹의 한국 콘텐츠 적합성** — 세로 영상, 옆모습, 다인 등에 대한 검출률.

## 9. 비기능 요구사항

### 9.1 성능

- 콜드 스타트 (앱 기동 → 첫 화면 인터랙션 가능): < 3초 (사이드카는 lazy 시작; 첫 작업 트리거 시점에 모델 로딩)
- 사이드카 + Whisper `small` 모델 hot 상태: 10분 영상 STT < 2분 (Apple Silicon 기준), Windows GPU(CUDA) 동급, CPU만이면 5~10분 허용
- UI 응답성: 모든 IPC 호출은 비차단; 진행도는 100ms 이내 첫 이벤트 emit

### 9.2 보안

- API 키는 평문 디스크 저장 금지(keytar 강제). 설정 export시에도 키 제외.
- 외부 URL 입력 검증: YouTube 도메인 화이트리스트(`youtube.com`, `youtu.be`, `m.youtube.com`)
- IPC 화이트리스트: `nodeIntegration: false`, `contextIsolation: true`, preload bridge로만 노출.
- 외부 도구 인자 escape: yt-dlp/ffmpeg에 사용자 입력은 인자 배열로만 전달(셸 문자열 결합 금지).

### 9.3 플랫폼

- macOS 12 이상 (Apple Silicon + Intel 모두)
- Windows 10/11 x64
- Linux는 v1 범위 외 (코드 호환은 깨지 않게 유지)

### 9.4 동시성

- v1: **동시 실행 잡 = 1개**. 두 번째 시작 요청은 큐에 대기.
- 큐 UI는 v1 범위에 포함 (Sidebar의 "작업중"이 큐 표시).

### 9.5 로컬화

- v1 UI 라벨 한국어 우선, 영문 보조. 추후 i18n 분리 가능하도록 라벨 상수화.

### 9.6 라이선스 / 외부 도구

- yt-dlp (Unlicense), ffmpeg (LGPL/GPL 빌드 변형 주의 — LGPL 빌드 사용), faster-whisper (MIT), MediaPipe (Apache 2.0).
- 배포 시 라이선스 표기 화면 포함.

## 10. v1 범위 외 (의도적 비포함)

- 다크 모드
- 자동 업데이트 (electron-updater)
- 클라우드 동기화 / 다중 기기
- TTS 더빙 / BGM 자동 추가
- YouTube 외 플랫폼(Twitch, Vimeo 등)
- 비디오 자체에 대한 시각 분석(현재는 트랜스크립트 only)
- 다중 사용자 / 팀 기능

## 11. 알려진 열린 문제

- **Python 번들 사이즈**: faster-whisper + MediaPipe + 의존성 합치면 200~400MB 수준 예상. PyInstaller `--onedir` vs `--onefile` 트레이드오프, 최종 크기는 PoC 후 결정.
- **Apple Silicon GPU 가속**: faster-whisper의 Metal 지원 상태가 빠르게 변하므로 M4 시점에 최신 상태 재확인 필요.
- **MediaPipe 라이선스 경계**: Apache 2.0이지만 일부 모델 가중치는 별도 라이선스가 있을 수 있어 배포 전 확인 필요.
