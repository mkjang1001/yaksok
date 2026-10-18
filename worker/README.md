# 약속 사진 글자 읽기 Worker

약 봉투·처방전 사진에서 **글자만** 읽어 주는 아주 작은 서버입니다 (Cloudflare Worker).
약 이름 매칭은 지금처럼 브라우저에서 합니다. 이 Worker는 글자 줄만 돌려줍니다.

```
POST /ocr   (multipart/form-data, 필드 이름 image, JPEG/PNG, 2MB 이하)
→ 200 {"lines": ["에소메프라졸정 40mg", "라베프라졸정 10mg", ...]}
```

| 상태 | 뜻 |
|---|---|
| 400 | 사진이 없음 |
| 403 | 허용되지 않은 사이트에서 온 요청 (CORS) |
| 413 | 2MB 넘음 |
| 415 | JPEG/PNG가 아님 (파일 앞부분으로 확인) |
| 429 | 한도 초과 — `{"error": "한국어 안내"}`, `Retry-After` 헤더 |
| 502 | Google Vision 호출 실패 |
| 503 | 키나 KV 저장소가 설정되지 않음 |

## 지키는 것

- **사진과 글자를 저장하지 않습니다.** 받은 사진은 Google Cloud Vision에 한 번 보내고 버립니다. `console.log` 같은 로그도 남기지 않고, `wrangler.toml`에서 Workers 로그(observability)도 꺼 둡니다.
- **무료 한도 안에서만 씁니다.** Google Vision 무료 한도는 한 달 1,000장입니다. 그래서
  - 전체: 하루 `DAILY_LIMIT`장 (기본 30장 × 30일 = 900장)
  - IP별: 1분 10장, 하루 50장
  - 한도는 한국 시간 자정에 풀립니다.
  - 요청 수는 Cloudflare KV에 셉니다. IP는 날짜와 섞어 해시한 값으로만 저장하고 이틀 뒤 저절로 지워집니다.
  - KV는 대략적인 카운터라서 동시에 몰리면 한두 장 넘을 수 있습니다. 그래서 전체 한도를 무료 한도보다 낮게 둡니다.
  - KV나 키가 없으면 셀 수 없으니 **아예 막습니다** (503).
- **허용한 사이트에서만** 부를 수 있습니다: `ALLOWED_ORIGINS` (쉼표로 구분). 기본값은 `https://mkjang1001.github.io`, `https://yaksok.pages.dev`, `http://localhost:5173`, `http://localhost:4173`.

## 배포 방법 (직접 하셔야 하는 단계)

> 아래 단계는 아직 아무도 실행하지 않았습니다. Cloudflare·Google 계정이 필요합니다.

### 1. Google Cloud Vision API 키 만들기

1. <https://console.cloud.google.com> 에서 프로젝트를 만듭니다.
2. 결제 계정을 연결합니다 (Vision은 무료 한도 안이라도 결제 계정이 있어야 켜집니다).
   과금 사고를 막으려면 **결제 → 예산 및 알림**에서 예산을 1,000원 정도로 걸어 두세요.
3. **API 및 서비스 → 라이브러리**에서 *Cloud Vision API*를 사용 설정합니다.
4. **사용자 인증 정보 → API 키 만들기**. 만든 키의 **API 제한사항**을 *Cloud Vision API*만 허용으로 바꿉니다.
5. (권장) **할당량**에서 Vision API 하루 요청 수를 40 정도로 낮춰 두면 Worker 한도가 뚫려도 무료 한도를 넘지 않습니다.

### 2. Cloudflare에 올리기

Cloudflare 계정(무료)을 만든 뒤, 이 폴더에서:

```bash
cd worker
npm install
npx wrangler login
npx wrangler kv namespace create RATE_LIMIT
```

마지막 명령이 알려 주는 `id`를 `wrangler.toml`의 `REPLACE_WITH_KV_NAMESPACE_ID` 자리에 넣습니다. 그다음:

```bash
npx wrangler secret put GOOGLE_VISION_API_KEY
npx wrangler deploy
```

키는 물어볼 때 붙여 넣습니다 (`wrangler.toml`이나 저장소에는 절대 쓰지 마세요).
배포가 끝나면 `https://yaksok-ocr.<내 계정>.workers.dev` 같은 주소가 나옵니다.

한도나 허용 사이트를 바꾸려면 `wrangler.toml`의 `[vars]`를 고치고 다시 `npx wrangler deploy` 하세요.

### 3. 웹앱에 주소 알려 주기

GitHub 저장소 → **Settings → Secrets and variables → Actions → Variables** 탭 → **New repository variable**

- 이름: `OCR_URL`
- 값: `https://yaksok-ocr.<내 계정>.workers.dev/ocr` (끝에 `/ocr`까지)

그다음 Actions에서 배포를 다시 돌리면 (또는 main에 새로 push하면) "약 봉투 찍기"가 사진 인식으로 바뀝니다.
변수를 지우면 다시 "약 봉투 보고 쓰기"(글자 입력)로 돌아갑니다.

### 4. 확인

```bash
curl -i -X POST -H "Origin: https://mkjang1001.github.io" -F "image=@봉투.jpg" https://yaksok-ocr.<내 계정>.workers.dev/ocr
```

`{"lines": [...]}`가 나오면 됩니다.

## 개발

```bash
npm install
npm test          # Vision은 가짜 fetch로 바꿔서 시험 (계정 필요 없음)
npx wrangler dev  # 로컬 실행 (.dev.vars 파일에 GOOGLE_VISION_API_KEY=... — 저장소에 올리지 마세요)
```
