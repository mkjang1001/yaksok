# 데이터 도구 (backend)

약물 DB를 만들고 웹앱용 조각 파일(`frontend/public/data/`)로 내보내는 파이썬 도구입니다. 배포하지 않습니다.

```
공공데이터포털 ──datagokr──▶ CSV ──validate csv──▶ cli import ──▶ SQLite ──export_static──▶ 조각 파일 ──validate db──▶ main 커밋 → 배포
```

| 모듈 | 하는 일 |
|---|---|
| `app/datagokr.py` | 공공데이터포털 API → 가져오기용 CSV. 페이지 끝까지, 호출 간격 유지, 일시 오류 재시도 |
| `app/cli.py` | CSV → SQLite (`init`, `import`, `templates`, `info`) |
| `app/export_static.py` | SQLite → 조각 파일 |
| `app/validate.py` | 새 데이터 검사. 실패하면 종료 코드 1 |
| `app/fake_data.py` | 가짜 품목 N개로 규모 측정 |
| `../.github/workflows/data-refresh.yml` | 위 과정을 매주 월요일 04:00(KST)과 수동 실행으로 돌림 |

```bash
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m pytest -q
```

## 서비스키를 받은 뒤 할 일

1. **활용 신청** — 공공데이터포털에서 아래 서비스를 각각 활용 신청합니다 (개발계정은 보통 자동 승인, 하루 호출 수 제한 있음).
   - 식품의약품안전처 의약품 제품 허가정보
   - 식품의약품안전처 DUR 성분정보 (병용금기·노인주의·효능군중복)
   - (필요하면) DUR 품목정보 — 품목별 DUR 성분코드
   - 의약품개요정보(e약은요), 의약품 낱알식별 정보
2. **설정 파일 만들기** — `data/datagokr_config.example.json`을 `data/datagokr_config.json`으로 복사합니다.
   - 각 job 의 `_check`에 적힌 것을 포털의 상세기능 명세(또는 미리보기 응답)와 대조해 `url`, `fields`를 고칩니다. 예시의 서비스 버전·필드 이름은 **확인 전 값**입니다.
   - `[ … ]`로 남은 자리표시(효능군 코드·이름 필드 등)를 채웁니다.
   - 확인한 job 은 `"verified": true`로 바꿉니다. 하나라도 `false`이거나 자리표시가 남아 있으면 수집을 시작하지 않습니다.
   - **성분코드 체계 확인이 가장 중요합니다.** 허가정보의 주성분코드(`[M…]`)와 DUR 성분코드가 다르면 규칙이 어떤 약에도 걸리지 않습니다. 이때는 "DUR 품목정보" job 을 켜서(`enabled: true`) 품목 → DUR 성분코드를 받습니다. `validate`가 "어떤 품목에도 없는 성분의 규칙" 비율로 알려 줍니다.
3. **로컬에서 한 번 돌려 보기** (PowerShell)
   ```powershell
   $env:DATA_GO_KR_SERVICE_KEY = "발급받은 일반 인증키(Decoding)"
   $env:YAKSOK_DB = "data\public.db"
   .venv\Scripts\python -m app.datagokr data\datagokr_config.json data\public
   .venv\Scripts\python -m app.validate csv data\public
   .venv\Scripts\python -m app.cli init
   .venv\Scripts\python -m app.cli import data\public
   .venv\Scripts\python -m app.export_static data\public-export
   .venv\Scripts\python -m app.validate db --previous-meta ..\frontend\public\data\meta.json --export-dir data\public-export
   ```
   `data/public/`, `data/public.db`는 커밋하지 않습니다. 결과가 이상하면 설정을 고쳐 다시 합니다.
   - Encoding 키를 넣어도 됩니다 (`%`가 있으면 풀어서 씀).
   - 발급 직후에는 "등록되지 않은 서비스키(30)"가 1~2시간 나올 수 있습니다.
4. **웹앱 테스트를 샘플 데이터에서 떼어 놓기 (프런트 작업, 먼저 해야 함)** — 아래 "프런트에 필요한 변경" 1번. 이것 없이 실제 데이터를 커밋하면 `npm test`가 깨져 배포가 멈춥니다. 자동 갱신 워크플로는 새 데이터로 `npm test`·`npm run build`를 먼저 돌려 보고, 실패하면 커밋하지 않고 이슈를 엽니다.
5. **GitHub 설정**
   - Settings › Secrets and variables › Actions › New repository secret: `DATA_GO_KR_SERVICE_KEY`
   - Settings › Actions › General › Workflow permissions: **Read and write permissions**
   - `backend/data/datagokr_config.json`을 커밋
6. **첫 실행** — Actions › data-refresh › Run workflow 에서 `dry_run`을 켜고 한 번 돌려 검사 보고서(실행 요약)를 봅니다. 괜찮으면 `dry_run` 없이 다시 돌립니다. 그 뒤로는 매주 월요일 04:00(KST)에 자동으로 돕니다.
7. **약사 검증 회귀 케이스 추가** — `data/regression_cases.json`에 실제 품목코드로 된 케이스를 `"dataset": "public"`으로 넣습니다. 지금 있는 케이스는 샘플용(`sample`)과 데이터와 무관한 것(`any`)뿐이라, 실제 데이터에서는 2개만 돕니다.

### 자동 갱신 워크플로가 하는 일

| 단계 | 실패하면 |
|---|---|
| 시크릿·설정 파일 확인 | 없으면 안내 메시지를 남기고 **성공으로 끝냄** (아무것도 안 바꿈) |
| `pytest` | 중단, 이슈 |
| 수집 (`datagokr`) | 키·한도·주소 문제는 바로, 일시 오류는 5번까지 다시 한 뒤 중단, 이슈 |
| `validate csv` → `import` → `export_static`(임시 폴더) → `validate db` | 중단, 이슈 (배포 데이터는 그대로) |
| 새 데이터로 웹앱 `npm test`·`npm run build` | 중단, 이슈 |
| `frontend/public/data` 교체 후 main 에 커밋 | `generated_at`만 바뀌었으면 커밋하지 않음 |
| `deploy.yml` 실행 | GITHUB_TOKEN 으로 올린 커밋은 push 트리거를 깨우지 않아서 직접 실행 |

실패 이슈 제목은 "데이터 자동 갱신 실패"이고, 이미 열린 이슈가 있으면 댓글로 덧붙입니다.

## 데이터 검사 (`app.validate`)

```bash
python -m app.validate csv <CSV 폴더>
python -m app.validate db [--db 파일] [--previous-meta meta.json] [--export-dir 폴더] [--cases 파일] [--report 보고서.md] [--thresholds 한도.json]
```

| 검사 | 기본 한도 | 결과 |
|---|---|---|
| 품목 수가 이전 `meta.json`보다 줄어듦 | 5% 초과 감소 | 실패 (이전이 샘플이면 건너뜀) |
| 품목 이름·업체·기준일 빈 비율 | 5% | 실패 |
| 성분이 하나도 없는 품목 비율 | 20% | 실패 |
| 규칙이 성분표에 없는 성분코드를 가리킴 | 0개 | 실패 |
| 어떤 품목에도 없는 성분의 규칙 비율 | 50% 경고 / 90% 실패 | 성분코드 체계 불일치 탐지 |
| 가져오기에서 건너뛴 줄 비율 (규칙, 품목-성분, 바코드) | 30% | 실패 |
| 점검 회귀 케이스 (`data/regression_cases.json`) | 모두 통과 | 실패 |
| 조각 파일 수 | 20,000 | 실패 (Cloudflare Pages 무료 한도) |
| 가장 큰 검색 조각 | 300KB | 경고 |

회귀 케이스 형식은 `tests/test_rules.py`의 기대값과 같습니다 (`rules`, `counts`, `med_count`, `unchecked`, `findings[{severity, items, ingredients, group, body, body_startswith, title}]`). `tests/test_validate.py`가 같은 파일을 파이썬 점검 엔진으로 돌려 봅니다.

가져오기(`cli import`)는 없는 품목·성분을 가리키는 줄(바코드, 품목-성분, 규칙)을 넣지 않고 건너뛴 수를 `meta`에 남깁니다. 예전에는 외래키 오류로 전체가 멈췄습니다.

## 조각 파일

| 경로 | 나누는 법 | 개수 |
|---|---|---|
| `search/<키>.json` | 이름 앞 두 글자 초성 (예: ㅇㅅ → `3147-3145`) | 있는 키만 |
| `search/<키3>.json` | 200KB 넘는 두 글자 키만 세 글자 초성으로 (예: `3147-3145-3141`) | 있는 키만 |
| `drug/`, `barcode/`, `insurance/` | 코드의 FNV-1a 해시 % 256 | 256씩, 빈 조각도 만듦 |
| `rule/` | 성분코드 해시 % 64 | 64 |

### 보험코드(EDI) 조각

`products.csv`에 선택 열 `insurance_codes`(세미콜론 구분, 예: `641900010;641900011`)가 있으면 `insurance/<bucket(code, 256)>.json`에 `{보험코드: 품목코드}`로 씁니다. 해시는 `bucket()`과 같고, `meta.json`의 `shards.insurance`가 256입니다. 처방전·약봉투에 찍힌 보험코드로 품목을 찾을 때 씁니다.

### 큰 검색 조각 나누기

두 글자 키 조각이 200KB(`SEARCH_SPLIT_BYTES`)를 넘으면, 그 키의 약만 앞 세 글자 초성 조각으로 옮깁니다.

- 두 글자 파일은 **그대로 배열**로 남고, 세 글자 키를 만들 수 없는 짧은 이름(두 글자 이름)만 들어 있습니다. 보통 `[]`입니다.
- `{"split": true}` 같은 객체를 두지 않은 이유: 지금 웹앱(`src/lib/search.ts`)은 받은 값을 `for…of`로 돌기 때문에 객체면 `TypeError`가 납니다. 배열이면 세 글자 키를 모르는 지금 웹앱도 깨지지 않고, 그 키의 검색 결과만 비게 됩니다.
- 어느 키가 나뉘었는지는 `meta.json`에 있습니다.
  ```json
  "split_search_keys": ["3147-3145"],
  "search_children": {"3147-3145": ["3147-3145-3141", "3147-3145-314c"]}
  ```
- 샘플 데이터는 어떤 조각도 200KB를 넘지 않아 결과가 예전과 같습니다 (`tests/test_export_static.py`가 커밋된 `frontend/public/data`와 바이트 단위로 비교).

## 프런트에 필요한 변경 (이 작업에서는 frontend/ 를 고치지 않음)

1. **[실제 데이터 전 필수] 테스트를 샘플 픽스처로** — `src/lib/engine.test.ts`가 `public/data`를 읽고 샘플 품목코드(S0000000…)를 기대합니다. 실제 데이터가 커밋되면 이 테스트가 깨져 `deploy.yml`이 멈춥니다. 샘플 조각을 테스트 전용 폴더(예: `src/lib/__fixtures__/data`, `python -m app.export_static`으로 생성)에 두고 그걸 읽게 바꿔야 합니다.
2. **나뉜 검색 키** — `Meta`에 `split_search_keys?: string[]`, `search_children?: Record<string, string[]>`를 추가하고, `searchKey(q)`가 나뉜 키이면
   - 검색어가 세 글자 이상: `searchKey(q, 3)` 조각 + 두 글자 파일(짧은 이름)을 받음
   - 검색어가 두 글자: "한 글자 더 써 주세요" 안내, 또는 `search_children`의 조각을 모두 받음 (크기 주의)
   - 봉투 글자 매칭(`matchLines`)도 같은 규칙
3. **보험코드로 찾기** — `DrugData.insurance(code)`: `insurance/${bucket(code, meta.shards.insurance)}.json` → 품목코드 → `drug()`. `meta.shards.insurance`가 없으면(예전 데이터) 찾지 않음.
4. **쉬운 분류 없음** — 실제 데이터에는 "혈압약" 같은 `easy_category`가 없습니다(공공데이터에 없는 값). 화면·문구가 `category`가 빈 경우를 자연스럽게 보여 주는지 확인이 필요합니다.

## 실제 규모 측정

`python -m app.fake_data 30000` (테스트: `tests/test_scale.py`). 가짜 이름은 실제처럼 "성분명+제형+함량(업체)" 복제약이 많아 몇몇 키에 몰리게 만들었고, 가장 흔한 성분 하나가 품목의 약 12%를 차지해 실제보다 치우친 편입니다. 2026-10-17, Windows 노트북, Python 3.12.

| 항목 | 3만 품목 |
|---|---|
| 가져오기 / 내보내기 시간 | 1.6초 / 2.8초 |
| 전체 파일 수 | **1,056개** (Cloudflare Pages 무료 20,000개 한도의 5%) |
| 전체 크기 | 18.3MB |
| `drug/` | 256개, 평균 50KB, 최대 60KB |
| `search/` | 222개, 평균 14KB, 최대 379KB (gzip 29KB) |
| 나뉜 검색 키 | 2개 (ㅇㅅ 14조각, ㅇㅌ 13조각) |
| `rule/` | 64개, 평균 17KB |
| `barcode/`, `insurance/` | 256개씩, 평균 4KB / 3KB |

알게 된 점

- 파일 수는 걱정 없습니다. 해시 조각 832개 + 검색 조각 수백 개라 품목이 늘어도 크게 늘지 않습니다.
- **세 글자로 나눠도 같은 성분명 복제약은 한 조각에 남습니다.** "아세트아미노펜…" 3,541개가 `ㅇㅅㅌ` 한 조각(379KB)에 모였습니다. GitHub Pages·Cloudflare Pages는 gzip/brotli로 보내므로 실제 전송은 약 29KB입니다. 실제 데이터에서도 300KB를 넘으면 `validate`가 경고하니, 그때 네 글자까지 나누거나(`SEARCH_SPLIT_CHARS`) 검색 줄에서 제조사 열을 빼는 방법을 검토합니다.
- `drug/` 조각이 품목 3만 개에서 평균 50KB입니다. 실제 품목이 10만 개를 넘으면 `DRUG_SHARDS`를 512로 올리면 됩니다 (웹앱은 `meta.json`의 조각 수를 읽으므로 그대로 동작).
- GitHub Pages는 파일 수 한도는 없고 사이트 1GB 권장 한도가 있습니다. 18MB 수준이라 여유가 큽니다.

## 아직 확인하지 못한 것

- 실제 API 호출 (서비스키 없음): 엔드포인트 주소·버전, 응답 필드 이름, 목록 오퍼레이션에 바코드·보험코드·주성분이 들어 있는지, 주성분코드와 DUR 성분코드가 같은 체계인지
- GitHub Actions 에서 워크플로 실제 실행 (문법만 확인)
