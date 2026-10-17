"""약물 DB → 서버 없는 웹앱용 정적 조각 파일.

전체 DB를 한 번에 내려받지 않도록 작은 조각으로 나눈다. 브라우저는 필요한 조각만 받는다.

  data/meta.json                 데이터 기준일, 규칙 버전, 조각 수
  data/templates.json            결과 문구 (작음)
  data/search/<키>.json          이름 앞 두 글자의 초성별 검색 목록   예) ㅇㅅ → 3147-3145.json
  data/search/<키3>.json         200KB를 넘는 두 글자 키만 앞 세 글자 초성으로 더 나눈 목록
                                 예) ㅇㅅㅁ → 3147-3145-3141.json (meta.json split_search_keys 참고)
  data/drug/<00~ff>.json         품목 상세 (품목코드 해시로 나눔)
  data/barcode/<00~ff>.json      바코드 → 품목코드
  data/rule/<00~3f>.json         성분별 점검 규칙 (성분코드 해시로 나눔)
  data/insurance/<00~ff>.json    보험코드(EDI) → 품목코드

검색 조각 나누기: 두 글자 키 조각이 SEARCH_SPLIT_BYTES 를 넘으면 그 키의 약을 세 글자 키 조각으로
옮기고, 두 글자 파일에는 세 글자 키를 만들 수 없는 짧은 이름만 남긴다 (보통 빈 배열 []).
두 글자 파일을 {"split": true} 같은 객체로 두지 않는 이유: 지금 웹앱(src/lib/search.ts)은 받은 값을
배열로 보고 for…of 로 돌기 때문에 객체면 오류가 난다. 배열로 두면 세 글자 키를 모르는 웹앱도
깨지지 않고 결과만 줄어든다. 어떤 키가 나뉘었는지는 meta.json 에 적는다.
  split_search_keys: ["3147-3145", …]                    나뉜 두 글자 키
  search_children:   {"3147-3145": ["3147-3145-3141", …]}  그 키 아래 세 글자 조각 목록

  python -m app.export_static ../frontend/public/data
"""
import json
import shutil
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from .db import RULE_VERSION, connect, get_meta
from .hangul import chosung, normalize
from .search import product_summaries

DRUG_SHARDS = 256
BARCODE_SHARDS = 256
RULE_SHARDS = 64
INSURANCE_SHARDS = 256
SEARCH_KEY_CHARS = 2
SEARCH_SPLIT_CHARS = 3
SEARCH_SPLIT_BYTES = 200 * 1024


def fnv1a(text: str) -> int:
    """웹앱(src/lib/shard.ts)과 똑같이 계산해야 한다."""
    h = 0x811C9DC5
    for b in text.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def bucket(text: str, shards: int) -> str:
    width = len(f"{shards - 1:x}")
    return f"{fnv1a(text) % shards:0{width}x}"


def search_key(name_norm: str, chars: int = SEARCH_KEY_CHARS) -> str | None:
    """정규화된 이름 앞 글자들의 초성을 유니코드 16진수로. 예) '에소메…' → '3147-3145'"""
    head = chosung(name_norm[:chars])
    if len(head) < chars:
        return None
    return "-".join(f"{ord(ch):x}" for ch in head)


def _dumps(data) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def _write(path: Path, data) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = _dumps(data)
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def split_search_shards(shards: dict[str, list[tuple[str, list]]], limit: int | None = None
                        ) -> tuple[dict[str, list], dict[str, list[str]]]:
    """shards: {두 글자 키: [(정규화 이름, 검색 줄), …]} → ({파일 키: 줄 목록}, {나뉜 키: 세 글자 키 목록})"""
    limit = SEARCH_SPLIT_BYTES if limit is None else limit
    files: dict[str, list] = {}
    children: dict[str, list[str]] = {}
    for key, entries in shards.items():
        rows = [row for _, row in entries]
        if len(_dumps(rows).encode("utf-8")) <= limit:
            files[key] = rows
            continue
        short, sub = [], defaultdict(list)
        for norm, row in entries:
            sub_key = search_key(norm, SEARCH_SPLIT_CHARS)
            (sub[sub_key] if sub_key else short).append(row)
        files[key] = short
        files.update(sub)
        children[key] = sorted(sub)
    return files, children


def _all_buckets(shards: int) -> list[str]:
    width = len(f"{shards - 1:x}")
    return [f"{i:0{width}x}" for i in range(shards)]


def export(conn, out_dir: Path) -> dict:
    out_dir = Path(out_dir)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    # 해시 조각은 비어 있어도 모두 만든다 (브라우저가 404 없이 빈 조각을 받도록)
    for name, shards in (("drug", DRUG_SHARDS), ("barcode", BARCODE_SHARDS), ("rule", RULE_SHARDS),
                         ("insurance", INSURANCE_SHARDS)):
        for key in _all_buckets(shards):
            _write(out_dir / name / f"{key}.json", {})

    seqs = [r["item_seq"] for r in conn.execute("SELECT item_seq FROM drug_product")]
    products = product_summaries(conn, seqs)

    # 품목 상세
    drug_shards: dict[str, dict] = defaultdict(dict)
    for seq, p in products.items():
        drug_shards[bucket(seq, DRUG_SHARDS)][seq] = p
    for key, items in drug_shards.items():
        _write(out_dir / "drug" / f"{key}.json", items)

    # 검색 목록: [품목코드, 이름, 쉬운 분류, 제조사, 모양, 색]
    by_key: dict[str, list] = defaultdict(list)
    for r in conn.execute("SELECT item_seq, name, name_norm FROM drug_product ORDER BY name"):
        key = search_key(r["name_norm"])
        if key:
            p = products[r["item_seq"]]
            by_key[key].append((r["name_norm"], [p["item_seq"], p["name"], p["category"], p["company"],
                                                 p["pill"]["shape"], p["pill"]["color"]]))
    search_shards, search_children = split_search_shards(by_key)
    search_sizes = {key: _write(out_dir / "search" / f"{key}.json", rows) for key, rows in search_shards.items()}

    # 바코드
    barcode_shards: dict[str, dict] = defaultdict(dict)
    for r in conn.execute("SELECT barcode, item_seq FROM drug_barcode"):
        barcode_shards[bucket(r["barcode"], BARCODE_SHARDS)][r["barcode"]] = r["item_seq"]
    for key, items in barcode_shards.items():
        _write(out_dir / "barcode" / f"{key}.json", items)

    # 보험코드(EDI)
    insurance_shards: dict[str, dict] = defaultdict(dict)
    for r in conn.execute("SELECT code, item_seq FROM drug_insurance"):
        insurance_shards[bucket(r["code"], INSURANCE_SHARDS)][r["code"]] = r["item_seq"]
    for key, items in insurance_shards.items():
        _write(out_dir / "insurance" / f"{key}.json", items)

    # 성분별 규칙. 병용금기는 양쪽 성분 모두에 적어 둔다.
    rules: dict[str, dict] = defaultdict(lambda: {"combo": [], "groups": [], "elderly": None})
    for r in conn.execute("SELECT * FROM dur_rule"):
        ev = {"detail": r["detail"], "source": r["source"], "data_date": r["data_date"]}
        if r["type"] == "COMBO_TABOO":
            rules[r["ingr_a"]]["combo"].append({"with": r["ingr_b"], **ev})
            rules[r["ingr_b"]]["combo"].append({"with": r["ingr_a"], **ev})
        elif r["type"] == "EFFICACY_DUP":
            rules[r["ingr_a"]]["groups"].append({"code": r["group_code"], "name": r["group_name"], **ev})
        elif r["type"] == "ELDERLY":
            rules[r["ingr_a"]]["elderly"] = ev
    rule_shards: dict[str, dict] = defaultdict(dict)
    for code, rule in rules.items():
        rule_shards[bucket(code, RULE_SHARDS)][code] = rule
    for key, items in rule_shards.items():
        _write(out_dir / "rule" / f"{key}.json", items)

    templates = [dict(r) for r in conn.execute("SELECT * FROM message_template ORDER BY rule_type")]
    _write(out_dir / "templates.json", templates)

    meta = get_meta(conn)
    summary = {
        "data_date": meta.get("data_date"),
        "rule_version": meta.get("rule_version", RULE_VERSION),
        "dataset": meta.get("dataset"),
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "shards": {"drug": DRUG_SHARDS, "barcode": BARCODE_SHARDS, "rule": RULE_SHARDS,
                   "insurance": INSURANCE_SHARDS, "search_key_chars": SEARCH_KEY_CHARS},
        "counts": {"products": len(products), "search_files": len(search_shards), "drug_files": len(drug_shards),
                   "rule_files": len(rule_shards), "barcode_files": len(barcode_shards),
                   "insurance_files": len(insurance_shards),
                   "files": sum(1 for f in out_dir.rglob("*.json")) + 1,
                   "max_search_file_bytes": max(search_sizes.values(), default=0)},
        "split_search_keys": sorted(search_children),
        "search_children": search_children,
    }
    _write(out_dir / "meta.json", summary)
    return summary


def main() -> None:
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    summary = export(connect(), Path(sys.argv[1]))
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
