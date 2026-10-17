"""공공데이터포털(식약처) API → 가져오기용 CSV 만들기.

  set DATA_GO_KR_SERVICE_KEY=발급받은키
  python -m app.datagokr data/datagokr_config.json data/public

그다음 `python -m app.cli import data/public` 로 DB에 넣는다.

주의: 엔드포인트 주소와 응답 필드 이름은 데이터셋 버전마다 바뀐다. 활용 신청 후 받은 최신 명세를 보고
datagokr_config.json 의 url / fields 를 먼저 맞춘 뒤 실행한다. 주소에 '[' 가 남아 있으면(자리표시)
실행하지 않는다.

설정 파일 형식 (data/datagokr_config.example.json 참고):
  defaults: page_size, min_interval_sec(호출 사이 최소 간격), max_retries, timeout_sec, max_pages
  jobs[]:   name, url, params, where{응답필드: [허용값…]}, outputs[]
  job 의 "verified": false 는 아직 명세와 대조하지 않았다는 뜻이다. 확인 후 true 로 바꿔야 실행된다.
  "enabled": false 인 job 은 건너뛴다.
  outputs[]: table(CSV 이름), fields{우리 열: 응답 필드 | [필드…](공백으로 이어 붙임)},
             transforms{우리 열: 변환 이름}, constants{우리 열: 고정값},
             explode{field, sep, as | pattern(이름 있는 그룹)}  한 칸에 여러 값이 있을 때 줄을 나눔
             enrich_only: true 면 앞선 job 이 만든 줄(같은 키)만 채우고 새 줄은 만들지 않음
  같은 표에 여러 job 이 쓰면 키(products 는 item_seq 등)가 같은 줄끼리 합치고, 빈 칸만 채운다.
"""
import csv
import html
import json
import random
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

from . import config

CSV_COLUMNS = {
    "products": ["item_seq", "name", "company", "is_otc", "easy_category", "easy_efficacy",
                 "pill_shape", "pill_color", "pill_image_url", "data_date", "insurance_codes"],
    "ingredients": ["ingr_code", "name_ko", "name_en"],
    "product_ingredients": ["item_seq", "ingr_code", "amount"],
    "barcodes": ["barcode", "item_seq"],
    "dur_rules": ["type", "ingr_a", "ingr_b", "group_code", "group_name", "detail", "source", "data_date"],
}
# 같은 키의 줄은 하나로 합친다. dur_rules 는 완전히 같은 줄만 지운다.
TABLE_KEYS = {
    "products": ("item_seq",),
    "ingredients": ("ingr_code",),
    "product_ingredients": ("item_seq", "ingr_code"),
    "barcodes": ("barcode",),
}

DEFAULTS = {"page_size": 100, "min_interval_sec": 0.3, "max_retries": 5, "timeout_sec": 30, "max_pages": 5000}

# 공공데이터포털 공통 오류 코드 (header.resultCode / returnReasonCode)
NO_DATA = {"03"}
RETRYABLE = {"01", "04", "05", "99"}
FATAL_MESSAGES = {
    "10": "요청 값이 잘못됐어요 (파라미터 확인).",
    "11": "필수 요청 값이 빠졌어요.",
    "12": "없는 서비스 주소예요. url 을 최신 명세와 비교하세요.",
    "20": "이 서비스에 대한 활용 신청(승인)이 없어요.",
    "22": "하루 호출 한도를 넘었어요. 내일 다시 하거나 운영 계정 전환을 신청하세요.",
    "30": "등록되지 않은 서비스키예요. 발급 직후라면 1~2시간 뒤 다시 해 보세요. 인코딩/디코딩 키도 확인하세요.",
    "31": "활용 기간이 끝난 서비스키예요. 연장 신청하세요.",
    "32": "등록되지 않은 IP예요.",
}


class ApiError(Exception):
    """다시 해도 소용없는 오류 (키·주소·한도 문제)."""


class RetryableError(Exception):
    pass


# ---------------------------------------------------------------- 호출

def service_key() -> str:
    key = config.DATA_GO_KR_SERVICE_KEY.strip()
    # 포털의 '인코딩' 키를 넣었으면 풀어서 쓴다 (urlencode 가 다시 인코딩한다)
    return urllib.parse.unquote(key) if "%" in key else key


def _default_open(url: str, timeout: float) -> bytes:
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "yaksok-data/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def parse_response(raw: bytes) -> tuple[list[dict], int]:
    """응답 → (items, totalCount). JSON 을 요청해도 오류는 XML 로 오는 경우가 있다."""
    text = raw.decode("utf-8", errors="replace").strip()
    if text.startswith("<"):
        code = re.search(r"<(?:returnReasonCode|resultCode)>\s*(\d+)\s*<", text)
        msg = re.search(r"<(?:returnAuthMsg|resultMsg)>\s*([^<]*)<", text)
        _raise_for_code(code.group(1) if code else "99", msg.group(1) if msg else text[:200])
        return [], 0
    data = json.loads(text)
    root = data.get("response", data)
    header = root.get("header") or {}
    code = str(header.get("resultCode", "00"))
    if code not in ("00", "0", "0000"):
        if code in NO_DATA:
            return [], 0
        _raise_for_code(code, header.get("resultMsg", ""))
    body = root.get("body") or {}
    items = body.get("items") or []
    if isinstance(items, dict):  # 일부 API는 {"item": [...]} 형태
        items = items.get("item") or []
    if isinstance(items, dict):
        items = [items]
    return items, int(body.get("totalCount") or 0)


def _raise_for_code(code: str, message: str) -> None:
    if code in NO_DATA:
        return
    if code in FATAL_MESSAGES:
        raise ApiError(f"[{code}] {FATAL_MESSAGES[code]} ({message})")
    raise RetryableError(f"[{code}] {message}")


class Fetcher:
    """페이지를 끝까지 받는다. 호출 간격을 지키고, 일시 오류는 점점 길게 쉬며 다시 한다."""

    def __init__(self, opener: Callable[[str, float], bytes] = _default_open, sleep: Callable[[float], None] = time.sleep,
                 **options):
        self.opener, self.sleep = opener, sleep
        self.options = {**DEFAULTS, **{k: v for k, v in options.items() if v is not None}}
        self._last = 0.0
        self.calls = 0

    def _wait_turn(self) -> None:
        gap = self.options["min_interval_sec"] - (time.monotonic() - self._last)
        if gap > 0:
            self.sleep(gap)
        self._last = time.monotonic()

    def get_page(self, url: str, params: dict, page: int) -> tuple[list[dict], int]:
        q = {"serviceKey": service_key(), "type": "json", "numOfRows": self.options["page_size"],
             "pageNo": page, **params}
        full = f"{url}?{urllib.parse.urlencode(q)}"
        retries = self.options["max_retries"]
        for attempt in range(retries + 1):
            self._wait_turn()
            self.calls += 1
            try:
                return parse_response(self.opener(full, self.options["timeout_sec"]))
            except ApiError:
                raise
            except urllib.error.HTTPError as e:
                if e.code not in (429, 500, 502, 503, 504):
                    raise ApiError(f"HTTP {e.code} — 주소나 파라미터를 확인하세요 ({url})") from e
                err: Exception = e
            except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError,
                    json.JSONDecodeError, RetryableError) as e:
                err = e
            if attempt == retries:
                raise ApiError(f"{retries}번 다시 했지만 실패: {err} ({url} {page}쪽)") from err
            delay = min(60.0, 2.0 * 2 ** attempt) + random.uniform(0, 1)
            print(f"  {page}쪽 실패({err}). {delay:.0f}초 뒤 다시 ({attempt + 1}/{retries})", file=sys.stderr)
            self.sleep(delay)
        raise AssertionError("unreachable")

    def fetch_all(self, url: str, params: dict | None = None) -> list[dict]:
        rows: list[dict] = []
        page, size = 1, self.options["page_size"]
        while page <= self.options["max_pages"]:
            items, total = self.get_page(url, params or {}, page)
            rows.extend(items)
            if page % 50 == 0:
                print(f"  {page}쪽, {len(rows)}/{total}건")
            if not items or page * size >= total:
                break
            page += 1
        else:
            raise ApiError(f"max_pages({self.options['max_pages']})를 넘었어요. 설정을 늘리세요.")
        return rows


# ---------------------------------------------------------------- 변환

COLORS = {
    "하양": "#ffffff", "흰색": "#ffffff", "노랑": "#f5d742", "주황": "#f39c4a", "분홍": "#f4a7b9",
    "빨강": "#e05252", "갈색": "#9b6a43", "연두": "#b5d96b", "초록": "#4caf50", "청록": "#3fb6a8",
    "파랑": "#4a7bd0", "남색": "#34477a", "자주": "#9b4f96", "보라": "#8e6cc0", "회색": "#9e9e9e",
    "검정": "#333333", "투명": "#f0f0f0",
}


def _date(v: str) -> str:
    digits = re.sub(r"\D", "", v)
    return f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}" if len(digits) >= 8 else v


def _shape(v: str) -> str:
    if not v:
        return ""
    if "캡슐" in v:
        return "capsule"
    return "round" if v.split()[0] == "원형" else "oval"


def _color(v: str) -> str:
    first = re.split(r"[,|/ ]", v.strip())[0] if v.strip() else ""
    return COLORS.get(first, "")


def _list(v: str) -> str:
    return ";".join(dict.fromkeys(p.strip() for p in re.split(r"[;,|\s]+", v) if p.strip()))


def _text(v: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", v))).strip()


TRANSFORMS: dict[str, Callable[[str], str]] = {
    "otc_flag": lambda v: "1" if "일반" in v else "0",
    "date": _date,
    "shape": _shape,
    "color": _color,
    "list": _list,
    "text": _text,
    "digits": lambda v: re.sub(r"\D", "", v),
}


def _value(raw: dict, src) -> str:
    if not src:
        return ""
    if isinstance(src, list):
        return " ".join(v for v in (_value(raw, s) for s in src) if v)
    v = raw.get(src)
    return "" if v is None else str(v).strip()


def map_rows(rows: list[dict], fields: dict, constants: dict | None = None, transforms: dict | None = None,
             explode: dict | None = None, where: dict | None = None) -> list[dict]:
    """fields: {우리 열: 응답 필드}. 응답 한 줄이 explode 로 여러 줄이 될 수 있다."""
    out = []
    for r in rows:
        if where and any(_value(r, k) not in allowed for k, allowed in where.items()):
            continue
        base = {col: _value(r, src) for col, src in fields.items()}
        parts: list[dict] = [{}]
        if explode:
            parts = []
            for piece in str(r.get(explode["field"]) or "").split(explode.get("sep", ",")):
                piece = piece.strip()
                if not piece:
                    continue
                if "pattern" in explode:
                    m = re.search(explode["pattern"], piece)
                    if m:
                        parts.append({k: (v or "").strip() for k, v in m.groupdict().items()})
                else:
                    parts.append({explode["as"]: piece})
        for extra in parts:
            mapped = {**base, **extra}
            for col, name in (transforms or {}).items():
                if col in mapped:
                    mapped[col] = TRANSFORMS[name](mapped[col])
            mapped.update(constants or {})
            out.append(mapped)
    return out


class Tables:
    """표별 줄 모음. 키가 같은 줄은 빈 칸만 채워 합친다."""

    def __init__(self):
        self.rows: dict[str, list[dict]] = {name: [] for name in CSV_COLUMNS}
        self.index: dict[str, dict[tuple, dict]] = {name: {} for name in TABLE_KEYS}

    def add(self, table: str, rows: list[dict], enrich_only: bool = False) -> int:
        if table not in CSV_COLUMNS:
            raise ValueError(f"알 수 없는 표: {table}")
        keys = TABLE_KEYS.get(table)
        added = 0
        for row in rows:
            if not keys:
                self.rows[table].append(row)
                added += 1
                continue
            key = tuple(row.get(k, "") for k in keys)
            if not all(key):
                continue
            existing = self.index[table].get(key)
            if existing is None:
                if enrich_only:
                    continue
                self.index[table][key] = row
                self.rows[table].append(row)
                added += 1
            else:
                for col, v in row.items():
                    if v and not existing.get(col):
                        existing[col] = v
        return added


def write_csvs(tables: dict[str, list[dict]], out_dir: Path) -> dict[str, int]:
    out_dir.mkdir(parents=True, exist_ok=True)
    counts = {}
    for name, cols in CSV_COLUMNS.items():
        with (out_dir / f"{name}.csv").open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
            w.writeheader()
            seen = set()
            for row in tables.get(name, []):
                key = tuple(row.get(c, "") for c in cols)
                if key not in seen:
                    seen.add(key)
                    w.writerow({c: row.get(c, "") for c in cols})
            counts[name] = len(seen)
    return counts


def job_outputs(job: dict) -> list[dict]:
    if "outputs" in job:
        return job["outputs"]
    return [{k: job[k] for k in ("table", "fields", "constants", "transforms", "explode", "enrich_only") if k in job}]


def check_config(cfg: dict) -> list[str]:
    """실행 전에 잡을 수 있는 설정 문제 목록."""
    problems = []
    for job in cfg.get("jobs", []):
        name = job.get("name", "?")
        if job.get("enabled", True) is False:
            continue
        if job.get("verified") is False:
            problems.append(f"[{name}] 아직 명세와 대조하지 않았어요. url·fields 를 확인한 뒤 \"verified\": true 로 바꾸세요.")
        if "[" in job.get("url", "[") or "]" in job.get("url", ""):
            problems.append(f"[{name}] url 이 아직 자리표시예요: {job.get('url')}")
        for out in job_outputs(job):
            if out.get("table") not in CSV_COLUMNS:
                problems.append(f"[{name}] 알 수 없는 표: {out.get('table')}")
                continue
            for col, src in out.get("fields", {}).items():
                if col not in CSV_COLUMNS[out["table"]]:
                    problems.append(f"[{name}] {out['table']} 에 없는 열: {col}")
                if any("[" in s for s in (src if isinstance(src, list) else [src or ""])):
                    problems.append(f"[{name}] {col} 응답 필드 이름이 아직 자리표시예요: {src}")
            for col, t in out.get("transforms", {}).items():
                if t not in TRANSFORMS:
                    problems.append(f"[{name}] 알 수 없는 변환: {t}")
    return problems


def collect(cfg: dict, fetcher: Fetcher) -> dict[str, list[dict]]:
    tables = Tables()
    for job in cfg["jobs"]:
        if job.get("enabled", True) is False:
            print(f"[{job['name']}] 꺼 둠 — 건너뜀")
            continue
        print(f"[{job['name']}] 받는 중…")
        rows = fetcher.fetch_all(job["url"], job.get("params", {}))
        print(f"  {len(rows)}건 받음")
        for out in job_outputs(job):
            mapped = map_rows(rows, out.get("fields", {}), out.get("constants"), out.get("transforms"),
                              out.get("explode"), job.get("where"))
            added = tables.add(out["table"], mapped, out.get("enrich_only", False))
            print(f"  → {out['table']}: 새 줄 {added}개")
    return tables.rows


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 2:
        print(__doc__)
        return 1
    if not config.DATA_GO_KR_SERVICE_KEY:
        print("DATA_GO_KR_SERVICE_KEY 환경 변수를 먼저 설정하세요.", file=sys.stderr)
        return 2
    cfg = json.loads(Path(argv[0]).read_text(encoding="utf-8"))
    problems = check_config(cfg)
    if problems:
        print("설정 파일을 먼저 고치세요:", *problems, sep="\n  ", file=sys.stderr)
        return 3
    fetcher = Fetcher(**cfg.get("defaults", {}))
    try:
        tables = collect(cfg, fetcher)
    except ApiError as e:
        print(f"수집 실패: {e}", file=sys.stderr)
        return 4
    counts = write_csvs(tables, Path(argv[1]))
    print(f"완료: {argv[1]} (API 호출 {fetcher.calls}번)", counts)
    return 0


if __name__ == "__main__":
    sys.exit(main())
