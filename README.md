# 약속 — 어르신 다제약물 점검 서비스 (서버 없는 웹앱)

어르신이 여러 병원·약국에서 받은 약을 한 목록으로 모으고, 같은 성분 중복·병용금기·효능군 중복·노인주의를 쉬운 말로 알려주는 웹앱입니다. 결과는 진단이 아니라 **약사·의사에게 물어볼 질문 목록**입니다.

> ⚠️ 지금 들어 있는 약 17개와 규칙 8개는 **개발용 샘플 데이터**입니다. 실제 의약품·DUR 정보가 아니며, 앱 화면과 출력물에도 그렇게 표시됩니다.

## 어떻게 동작하나

서버가 없습니다. 정적 파일(HTML·JS·JSON)만 무료 호스팅(GitHub Pages, Cloudflare Pages)에 올리면 됩니다.

- **점검은 브라우저 안에서 합니다.** 내 약 목록은 기기(IndexedDB) 밖으로 나가지 않습니다.
- **약물 DB 전체를 내려받지 않습니다.** DB를 작은 조각 파일로 나눠 두고, 필요한 조각만 받습니다.

| 언제 | 받는 파일 | 내용 |
|---|---|---|
| 이름 검색 | `search/<초성>.json` 1개 | 검색어 앞 두 글자 초성이 같은 약 이름 목록 (예: "에소" → ㅇㅅ 조각) |
| 봉투 글자 매칭 | 줄마다 `search/<초성>.json` | 후보 표시는 이름 목록만으로. 상세는 받지 않음 |
| 바코드 | `barcode/<해시>.json` 1개 | 바코드 → 품목코드 |
| 약을 목록에 넣을 때 | `drug/<해시>.json` | **넣은 약**의 성분 등 상세 |
| 점검할 때 | `drug/…`, `rule/<해시>.json` | **등록한 약**의 상세와 그 성분들의 규칙만 |
| 처음 한 번 | `meta.json`, `templates.json` | 데이터 기준일, 결과 문구 (몇 KB) |

받은 조각은 메모리에 두고 다시 받지 않습니다. 해시 조각 하나에는 여러 약이 섞여 있어서, 호스팅 서버 쪽에서는 어떤 약을 등록했는지 정확히 알 수 없습니다.

> 이름 검색은 앞 두 글자 조각 안에서만 찾습니다. 그래서 **두 글자 이상** 써야 하고, 첫 두 글자에 오타가 있으면 못 찾을 수 있습니다. 그 뒤 글자의 오타는 찾아 줍니다.

## 구성

```
yaksok/
├─ frontend/                    웹앱 (React + TypeScript + Vite) — 배포 대상
│  ├─ public/data/              약물 DB 조각 파일 (export_static 이 만듦)
│  └─ src/
│     ├─ lib/data.ts            조각 파일 받기·캐시, 해시 나누기
│     ├─ lib/search.ts          이름 검색, 봉투 글자 매칭
│     ├─ lib/rules.ts           점검 엔진 R1~R5 (설계서 B5)
│     ├─ lib/hangul.ts          초성·자모·조사(와/과, 이/가)
│     ├─ lib/engine.test.ts     테스트 19개
│     └─ screens/               화면 S01~S11
├─ backend/                     데이터 도구 (Python) — 배포하지 않음
│  ├─ app/db.py, cli.py         CSV → SQLite
│  ├─ app/export_static.py      SQLite → 조각 파일
│  ├─ app/datagokr.py           공공데이터포털 → CSV
│  ├─ app/rules.py …            같은 규칙의 파이썬 구현 (결과 대조용)
│  ├─ app/main.py               (선택) 로컬 API 서버 — 지금 웹앱은 쓰지 않음
│  └─ tests/                    테스트 27개
└─ .github/workflows/deploy.yml GitHub Pages 자동 배포
```

## 로컬에서 실행

필요한 것: Node.js 18 이상. 데이터를 바꿀 때만 Python 3.10 이상.

```bash
cd yaksok/frontend
npm install
npm run dev
```

http://localhost:5173 을 엽니다. 배포본과 똑같이 보려면:

```bash
cd yaksok/frontend
npm run build
npm run preview
```

테스트:

```bash
cd yaksok/frontend
npm test
```

## 무료로 배포하기

### GitHub Pages (추천)

1. GitHub에 저장소를 만들고 `yaksok` 폴더 내용을 올립니다 (`frontend/public/data` 포함).
2. 저장소 **Settings › Pages › Source**를 **GitHub Actions**로 바꿉니다.
3. `main` 브랜치에 올릴 때마다 테스트 → 빌드 → 배포가 자동으로 됩니다. 주소는 `https://<아이디>.github.io/<저장소>/`.

### Cloudflare Pages — https://yaksok.pages.dev

GitHub Pages와 **같은 빌드**를 함께 올립니다. Pages 프로젝트 `yaksok`은 이미 만들어 두었습니다.

- 자동 배포: `deploy.yml`이 빌드 뒤 `wrangler pages deploy`로 올립니다. 저장소에 아래 두 값이 있을 때만 동작하고, 없으면 그 단계만 건너뜁니다.
  - Secret `CLOUDFLARE_API_TOKEN`: Cloudflare › My Profile › API Tokens › Create Token › Custom token, 권한 **Account · Cloudflare Pages · Edit** 하나만.
  - Variable `CLOUDFLARE_ACCOUNT_ID`: Cloudflare 계정 ID.
- 손으로 올리기 (PC에서 `wrangler login` 한 뒤):

```bash
cd yaksok/frontend
npm run build
npx wrangler pages deploy dist --project-name yaksok --branch main
```

무료 플랜은 배포당 파일 2만 개까지라, 실제 데이터를 넣은 뒤 조각 파일 수를 확인하세요 (`meta.json`의 `counts`).

두 방식 모두 주소에 `#/result`처럼 `#`이 붙는 방식이라, 새로고침해도 404가 나지 않습니다.

## 데이터 바꾸기 (Python)

```bash
cd yaksok/backend
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m pytest -q
```

샘플로 다시 만들기:

```bash
.venv\Scripts\python -m app.cli init --sample
.venv\Scripts\python -m app.export_static ..\frontend\public\data
```

실제 공공데이터로 바꾸기:

1. 공공데이터포털에서 식약처 DUR 품목·성분정보, 의약품 제품 허가정보, 낱알식별, e약은요 활용 신청 → 서비스키 발급
2. `data/datagokr_config.example.json`을 복사해 `url`과 `fields`(응답 필드 이름)를 최신 명세로 채움 (예시 값은 자리표시)
3. `$env:DATA_GO_KR_SERVICE_KEY = "..."` 후 `python -m app.datagokr data/datagokr_config.json data/public`
4. `python -m app.cli import data/public`
5. `python -m app.export_static ..\frontend\public\data` → 커밋하면 배포됨

CSV 형식은 `data/sample/`과 같습니다.

### 결과 문구 감수

`backend/data/templates.json`의 각 문구에 `approved_by`, `approved_at`을 채운 뒤 `python -m app.cli templates`와 `export_static`을 다시 실행합니다. 시범 운영 전에는 빌드할 때 `VITE_STRICT_APPROVAL=true`로 감수 전 문구를 숨깁니다.

## 빌드 설정 (환경 변수)

| 변수 | 설명 |
|---|---|
| `VITE_STRICT_APPROVAL` | `true`면 감수 약사 승인이 없는 문구를 보여 주지 않음 |
| `VITE_OCR_URL` | (선택) 사진 인식 주소. 비우면 "약 봉투 보고 쓰기"(글자 입력)만 씀. 사진을 `image`로 POST 받아 `{"lines": ["줄1", "줄2"]}`를 돌려주는 곳이면 됨. 매칭은 브라우저에서 함 |

## 개인정보 설계

- 내 약 목록, 점검 결과, 설정은 브라우저 IndexedDB에만 저장됩니다
- 점검 계산도 브라우저 안에서 합니다. 서버로 보내는 개인 데이터가 없습니다
- 도우미 모드 통계(점검 건수, 약 개수, 꼭 확인 여부)는 그 기기 안에 기관 코드별로 쌓입니다
- 사진 인식을 연결하면 그때만 사진이 그 주소로 갑니다

## 아직 하지 않은 것

- 실제 공공데이터 수집 (서비스키와 최신 명세 필요)
- 감수 약사의 문구 승인
- 사진 인식 연결 (지금은 봉투 글자 입력)
- 여러 기기 통계 합치기 (필요하면 무료 DB 연결)
- 오프라인용 서비스 워커
- 보호자 공유, 항콜린 부담 점수 등 v2 기능
