"""공공데이터포털(식약처) API → 가져오기용 CSV 만들기.

  set DATA_GO_KR_SERVICE_KEY=발급받은키
  python -m app.datagokr data/datagokr_config.json data/public

그다음 `python -m app.cli import data/public` 로 DB에 넣는다.

주의: 엔드포인트 주소와 응답 필드 이름은 데이터셋 버전마다 바뀐다. 활용 신청 후 받은 최신 명세를 보고
datagokr_config.json 의 url / fields 를 먼저 맞춘 뒤 실행한다. (예시 파일의 값은 확인 전 자리표시다.)
"""
import csv
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from . import config

CSV_COLUMNS = {
    "products": ["item_seq", "name", "company", "is_otc", "easy_category", "easy_efficacy",
                 "pill_shape", "pill_color", "pill_image_url", "data_date"],
    "ingredients": ["ingr_code", "name_ko", "name_en"],
    "product_ingredients": ["item_seq", "ingr_code", "amount"],
    "barcodes": ["barcode", "item_seq"],
    "dur_rules": ["type", "ingr_a", "ingr_b", "group_code", "group_name", "detail", "source", "data_date"],
}


def fetch_all(url: str, params: dict, page_size: int = 100, max_pages: int = 2000) -> list[dict]:
    """공공데이터포털 JSON 응답(body.items)을 페이지 끝까지 받는다."""
    rows, page = [], 1
    while page <= max_pages:
        q = {"serviceKey": config.DATA_GO_KR_SERVICE_KEY, "type": "json", "numOfRows": page_size,
             "pageNo": page, **params}
        with urllib.request.urlopen(f"{url}?{urllib.parse.urlencode(q)}", timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        body = data.get("body") or data.get("response", {}).get("body", {})
        items = body.get("items") or []
        if isinstance(items, dict):  # 일부 API는 {"item": [...]} 형태
            items = items.get("item") or []
        if isinstance(items, dict):
            items = [items]
        rows.extend(items)
        total = int(body.get("totalCount") or 0)
        if not items or page * page_size >= total:
            break
        page += 1
        time.sleep(0.2)  # 호출 제한 배려
    return rows


def map_rows(rows: list[dict], fields: dict, constants: dict | None = None) -> list[dict]:
    """fields: {우리 컬럼: 응답 필드 이름}. constants: 모든 행에 넣을 고정값."""
    out = []
    for r in rows:
        mapped = {col: (str(r.get(src, "")).strip() if src else "") for col, src in fields.items()}
        mapped.update(constants or {})
        out.append(mapped)
    return out


def write_csvs(tables: dict[str, list[dict]], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
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


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    if not config.DATA_GO_KR_SERVICE_KEY:
        sys.exit("DATA_GO_KR_SERVICE_KEY 환경 변수를 먼저 설정하세요.")
    cfg = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    tables: dict[str, list[dict]] = {}
    for job in cfg["jobs"]:
        print(f"[{job['name']}] 받는 중…")
        rows = fetch_all(job["url"], job.get("params", {}))
        print(f"  {len(rows)}건")
        tables.setdefault(job["table"], []).extend(map_rows(rows, job["fields"], job.get("constants")))
    write_csvs(tables, Path(sys.argv[2]))
    print("완료:", sys.argv[2])


if __name__ == "__main__":
    main()
