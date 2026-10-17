"""약물 DB → 서버 없는 웹앱용 정적 조각 파일.

전체 DB를 한 번에 내려받지 않도록 작은 조각으로 나눈다. 브라우저는 필요한 조각만 받는다.

  data/meta.json                 데이터 기준일, 규칙 버전, 조각 수
  data/templates.json            결과 문구 (작음)
  data/search/<키>.json          이름 앞 두 글자의 초성별 검색 목록   예) ㅇㅅ → 3147-3145.json
  data/drug/<00~ff>.json         품목 상세 (품목코드 해시로 나눔)
  data/barcode/<00~ff>.json      바코드 → 품목코드
  data/rule/<00~3f>.json         성분별 점검 규칙 (성분코드 해시로 나눔)

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
SEARCH_KEY_CHARS = 2


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


def search_key(name_norm: str) -> str | None:
    """정규화된 이름 앞 두 글자의 초성을 유니코드 16진수로. 예) '에소메…' → '3147-3145'"""
    head = chosung(name_norm[:SEARCH_KEY_CHARS])
    if len(head) < SEARCH_KEY_CHARS:
        return None
    return "-".join(f"{ord(ch):x}" for ch in head)


def _write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def _all_buckets(shards: int) -> list[str]:
    width = len(f"{shards - 1:x}")
    return [f"{i:0{width}x}" for i in range(shards)]


def export(conn, out_dir: Path) -> dict:
    out_dir = Path(out_dir)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    # 해시 조각은 비어 있어도 모두 만든다 (브라우저가 404 없이 빈 조각을 받도록)
    for name, shards in (("drug", DRUG_SHARDS), ("barcode", BARCODE_SHARDS), ("rule", RULE_SHARDS)):
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
    search_shards: dict[str, list] = defaultdict(list)
    for r in conn.execute("SELECT item_seq, name, name_norm FROM drug_product ORDER BY name"):
        key = search_key(r["name_norm"])
        if key:
            p = products[r["item_seq"]]
            search_shards[key].append([p["item_seq"], p["name"], p["category"], p["company"],
                                       p["pill"]["shape"], p["pill"]["color"]])
    for key, rows in search_shards.items():
        _write(out_dir / "search" / f"{key}.json", rows)

    # 바코드
    barcode_shards: dict[str, dict] = defaultdict(dict)
    for r in conn.execute("SELECT barcode, item_seq FROM drug_barcode"):
        barcode_shards[bucket(r["barcode"], BARCODE_SHARDS)][r["barcode"]] = r["item_seq"]
    for key, items in barcode_shards.items():
        _write(out_dir / "barcode" / f"{key}.json", items)

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
                   "search_key_chars": SEARCH_KEY_CHARS},
        "counts": {"products": len(products), "search_files": len(search_shards), "drug_files": len(drug_shards),
                   "rule_files": len(rule_shards), "barcode_files": len(barcode_shards)},
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
