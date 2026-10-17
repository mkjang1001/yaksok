"""새로 받은 데이터 검사. 통과해야 웹앱 데이터(frontend/public/data)를 바꾼다.

  python -m app.validate csv <CSV 폴더>                 가져오기 전 CSV 검사 (필수 칸, 연결)
  python -m app.validate db [--previous-meta 이전/meta.json] [--export-dir 새/data]
                            [--cases data/regression_cases.json] [--report 보고서.md]

검사 항목 (db):
  - 품목 수가 이전 meta.json 보다 5% 넘게 줄었는가
  - 품목 필수 칸(이름·업체·기준일) 빈 비율
  - 성분이 하나도 없는 품목 비율
  - 규칙이 가리키는 성분코드가 성분표에 있는가, 그 성분을 가진 품목이 있는가
  - 가져오기에서 건너뛴 줄(없는 품목·성분을 가리킨 줄) 비율
  - 점검 회귀 케이스 (tests/test_rules.py 와 같은 기대값 형식의 JSON)
  - (--export-dir) 조각 파일 수, 너무 큰 조각

문제가 하나라도 있으면 종료 코드 1. 경고는 통과로 본다.
"""
import argparse
import csv
import json
import sqlite3
import sys
from dataclasses import dataclass, field
from pathlib import Path

from . import config
from .db import connect, get_meta
from .rules import Checker

DEFAULT_CASES = config.BASE_DIR / "data" / "regression_cases.json"

THRESHOLDS = {
    "max_product_drop": 0.05,          # 이전보다 품목 수가 이만큼 넘게 줄면 실패
    "max_missing_required": 0.05,      # 필수 칸이 빈 품목 비율
    "max_no_ingredient": 0.20,         # 성분이 없는 품목 비율 (한약재·의약외품 등은 성분코드가 없을 수 있다)
    "max_dropped_rules": 0.30,         # 가져오기에서 버려진 규칙 비율 (높으면 성분코드 체계가 어긋난 것)
    "max_dropped_links": 0.30,         # 가져오기에서 버려진 품목-성분 연결 비율
    "warn_unused_rule_ingredients": 0.50,  # 어떤 품목에도 없는 성분을 가리키는 규칙 비율: 넘으면 경고
    "max_unused_rule_ingredients": 0.90,   # 넘으면 실패 (품목 성분코드와 DUR 성분코드 체계가 다른 것)
    "max_files": 20000,                # Cloudflare Pages 무료 플랜 배포당 파일 수 한도
    "warn_search_file_bytes": 300 * 1024,
}

REQUIRED_PRODUCT_FIELDS = ("name", "company", "data_date")


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    info: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def check(self, passed: bool, message: str, warn_only: bool = False) -> None:
        if passed:
            self.info.append(message)
        elif warn_only:
            self.warnings.append(message)
        else:
            self.errors.append(message)

    def markdown(self) -> str:
        lines = [f"## 데이터 검사 {'통과' if self.ok else '실패'}", ""]
        for title, items, mark in (("문제", self.errors, "❌"), ("경고", self.warnings, "⚠️"),
                                   ("통과", self.info, "✅")):
            if items:
                lines += [f"### {title}", *[f"- {mark} {m}" for m in items], ""]
        return "\n".join(lines)


def _ratio(part: int, whole: int) -> float:
    return part / whole if whole else 0.0


def _pct(x: float) -> str:
    return f"{x * 100:.1f}%"


# ---------------------------------------------------------------- CSV (가져오기 전)

CSV_REQUIRED = {
    "products.csv": ("item_seq", "name"),
    "ingredients.csv": ("ingr_code", "name_ko"),
    "product_ingredients.csv": ("item_seq", "ingr_code"),
    "barcodes.csv": ("barcode", "item_seq"),
    "dur_rules.csv": ("type", "ingr_a"),
}
RULE_TYPES = {"COMBO_TABOO", "EFFICACY_DUP", "ELDERLY"}


def _read(path: Path) -> list[dict] | None:
    if not path.exists():
        return None
    with path.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def validate_csv(directory: Path, thresholds: dict = THRESHOLDS) -> Report:
    directory = Path(directory)
    rep = Report()
    tables: dict[str, list[dict]] = {}
    for name, cols in CSV_REQUIRED.items():
        rows = _read(directory / name)
        if rows is None:
            rep.check(False, f"{name} 없음", warn_only=name != "products.csv")
            rows = []
        tables[name] = rows
        if rows:
            missing_cols = [c for c in cols if c not in rows[0]]
            rep.check(not missing_cols, f"{name}: 필수 열 " + (f"{missing_cols} 없음" if missing_cols else "모두 있음"))
            blank = sum(1 for r in rows if any(not (r.get(c) or "").strip() for c in cols))
            rep.check(blank == 0, f"{name}: 필수 칸이 빈 줄 {blank}개 / {len(rows)}개",
                      warn_only=_ratio(blank, len(rows)) <= thresholds["max_missing_required"])

    products = tables["products.csv"]
    rep.check(bool(products), f"품목 {len(products)}개")
    seqs = [r.get("item_seq", "") for r in products]
    dup = len(seqs) - len(set(seqs))
    rep.check(dup == 0, f"품목코드 중복 {dup}개", warn_only=True)

    codes = {r.get("ingr_code", "") for r in tables["ingredients.csv"]}
    seq_set = set(seqs)
    links = tables["product_ingredients.csv"]
    bad_links = sum(1 for r in links if r.get("item_seq") not in seq_set or r.get("ingr_code") not in codes)
    rep.check(_ratio(bad_links, len(links)) <= thresholds["max_dropped_links"],
              f"없는 품목·성분을 가리키는 품목-성분 연결 {bad_links}개 / {len(links)}개 ({_pct(_ratio(bad_links, len(links)))})")

    rules = tables["dur_rules.csv"]
    bad_type = sum(1 for r in rules if r.get("type") not in RULE_TYPES)
    rep.check(bad_type == 0, f"알 수 없는 규칙 종류 {bad_type}개")
    bad_rules = sum(1 for r in rules
                    if r.get("ingr_a") not in codes or ((r.get("ingr_b") or "") and r.get("ingr_b") not in codes))
    rep.check(_ratio(bad_rules, len(rules)) <= thresholds["max_dropped_rules"],
              f"성분표에 없는 성분코드를 가리키는 규칙 {bad_rules}개 / {len(rules)}개 ({_pct(_ratio(bad_rules, len(rules)))})")
    combos_without_b = sum(1 for r in rules if r.get("type") == "COMBO_TABOO" and not r.get("ingr_b"))
    rep.check(combos_without_b == 0, f"상대 성분이 빈 병용금기 {combos_without_b}개")
    return rep


# ---------------------------------------------------------------- DB (가져온 뒤)

def _count(conn: sqlite3.Connection, sql: str) -> int:
    return conn.execute(sql).fetchone()[0]


def check_product_count(conn, rep: Report, previous_meta: dict | None, thresholds: dict) -> None:
    n = _count(conn, "SELECT COUNT(*) FROM drug_product")
    rep.check(n > 0, f"품목 {n}개")
    prev = ((previous_meta or {}).get("counts") or {}).get("products")
    if not prev:
        rep.info.append("이전 meta.json 이 없어 품목 수 비교는 건너뜀")
        return
    if (previous_meta or {}).get("dataset") == "sample":
        rep.info.append(f"이전 데이터가 샘플({prev}개)이라 품목 수 감소 검사는 건너뜀")
        return
    drop = _ratio(prev - n, prev)
    rep.check(drop <= thresholds["max_product_drop"],
              f"품목 수 {prev} → {n} ({'감소 ' + _pct(drop) if drop > 0 else '감소 없음'}, 한도 {_pct(thresholds['max_product_drop'])})")


def check_required_fields(conn, rep: Report, thresholds: dict) -> None:
    n = _count(conn, "SELECT COUNT(*) FROM drug_product") or 1
    for col in REQUIRED_PRODUCT_FIELDS:
        missing = _count(conn, f"SELECT COUNT(*) FROM drug_product WHERE {col} IS NULL OR TRIM({col}) = ''")
        rep.check(_ratio(missing, n) <= thresholds["max_missing_required"],
                  f"품목 '{col}' 빈 비율 {_pct(_ratio(missing, n))} (한도 {_pct(thresholds['max_missing_required'])})")


def check_ingredients(conn, rep: Report, thresholds: dict) -> None:
    n = _count(conn, "SELECT COUNT(*) FROM drug_product") or 1
    none = _count(conn, """SELECT COUNT(*) FROM drug_product p
                           WHERE NOT EXISTS (SELECT 1 FROM product_ingredient pi WHERE pi.item_seq = p.item_seq)""")
    rep.check(_ratio(none, n) <= thresholds["max_no_ingredient"],
              f"성분 없는 품목 {none}개 ({_pct(_ratio(none, n))}, 한도 {_pct(thresholds['max_no_ingredient'])})")


def check_rule_refs(conn, rep: Report, thresholds: dict) -> None:
    total = _count(conn, "SELECT COUNT(*) FROM dur_rule")
    rep.check(total > 0, f"점검 규칙 {total}개")
    missing = _count(conn, """SELECT COUNT(*) FROM dur_rule r
        WHERE NOT EXISTS (SELECT 1 FROM ingredient i WHERE i.ingr_code = r.ingr_a)
           OR (r.ingr_b IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ingredient i WHERE i.ingr_code = r.ingr_b))""")
    rep.check(missing == 0, f"성분표에 없는 성분코드를 가리키는 규칙 {missing}개")
    unused = _count(conn, """SELECT COUNT(*) FROM dur_rule r
        WHERE NOT EXISTS (SELECT 1 FROM product_ingredient pi WHERE pi.ingr_code = r.ingr_a)""")
    unused_ratio = _ratio(unused, total)
    rep.check(unused_ratio <= thresholds["warn_unused_rule_ingredients"],
              f"어떤 품목에도 없는 성분의 규칙 {unused}개 ({_pct(unused_ratio)}"
              + (", 성분코드 체계가 어긋났을 수 있음)" if unused_ratio > thresholds["max_unused_rule_ingredients"] else ")"),
              warn_only=unused_ratio <= thresholds["max_unused_rule_ingredients"])
    combos_without_b = _count(conn, "SELECT COUNT(*) FROM dur_rule WHERE type = 'COMBO_TABOO' AND ingr_b IS NULL")
    rep.check(combos_without_b == 0, f"상대 성분이 빈 병용금기 {combos_without_b}개")


def check_import_drops(conn, rep: Report, thresholds: dict) -> None:
    meta = get_meta(conn)
    if "import_dropped" not in meta:
        return
    dropped = json.loads(meta["import_dropped"] or "{}")
    source = json.loads(meta.get("import_source_counts") or "{}")
    for table, limit in (("dur_rules", thresholds["max_dropped_rules"]),
                         ("product_ingredients", thresholds["max_dropped_links"]),
                         ("barcodes", thresholds["max_dropped_links"])):
        d, s = dropped.get(table, 0), source.get(table, 0)
        rep.check(_ratio(d, s) <= limit, f"가져오기에서 건너뛴 {table} {d}개 / {s}개 ({_pct(_ratio(d, s))})")


def load_cases(path: Path) -> list[dict]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return data["cases"] if isinstance(data, dict) else data


def run_case(checker: Checker, case: dict) -> list[str]:
    """기대값과 다른 점 목록 (같으면 빈 목록). expect 형식은 tests/test_rules.py 의 assert 와 같다."""
    result = checker.check(case.get("age_band", "65+"), case["items"])
    exp, diffs = case.get("expect", {}), []

    def cmp(label, actual, expected):
        if actual != expected:
            diffs.append(f"{label}: 기대 {expected!r}, 실제 {actual!r}")

    if "rules" in exp:
        cmp("rules", [f["rule"] for f in result["findings"]], exp["rules"])
    if "counts" in exp:
        cmp("counts", result["counts"], exp["counts"])
    if "med_count" in exp:
        cmp("med_count", result["med_count"], exp["med_count"])
    if "unchecked" in exp:
        cmp("unchecked", [u["display_name"] for u in result["unchecked"]], exp["unchecked"])
    for i, fexp in enumerate(exp.get("findings", [])):
        if i >= len(result["findings"]):
            diffs.append(f"findings[{i}] 없음")
            continue
        f = result["findings"][i]
        for key, value in fexp.items():
            if key == "items":
                cmp(f"findings[{i}].items", sorted(f.get("items", [])), sorted(value))
            elif key == "body_startswith":
                if not (f.get("body") or "").startswith(value):
                    diffs.append(f"findings[{i}].body 가 {value!r} 로 시작하지 않음: {f.get('body')!r}")
            else:
                cmp(f"findings[{i}].{key}", f.get(key), value)
    return diffs


def check_cases(conn, rep: Report, cases_path: Path | None) -> None:
    if not cases_path or not Path(cases_path).exists():
        rep.warnings.append("점검 회귀 케이스 파일이 없음")
        return
    dataset = get_meta(conn).get("dataset")
    cases = [c for c in load_cases(cases_path) if c.get("dataset", "any") in ("any", dataset)]
    if not cases:
        rep.warnings.append(f"'{dataset}' 데이터용 점검 회귀 케이스가 없음 — 약사 검증 케이스를 추가하세요")
        return
    checker = Checker(conn, strict_approval=False)
    failed = 0
    for case in cases:
        diffs = run_case(checker, case)
        if diffs:
            failed += 1
            rep.errors.append(f"회귀 케이스 '{case['name']}' 실패: " + "; ".join(diffs))
    if not failed:
        rep.info.append(f"점검 회귀 케이스 {len(cases)}개 통과")


def check_export(rep: Report, export_dir: Path, thresholds: dict) -> None:
    export_dir = Path(export_dir)
    meta_path = export_dir / "meta.json"
    if not meta_path.exists():
        rep.errors.append(f"{meta_path} 없음")
        return
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    files = sum(1 for _ in export_dir.rglob("*.json"))
    rep.check(files <= thresholds["max_files"], f"조각 파일 {files}개 (한도 {thresholds['max_files']})")
    search = list((export_dir / "search").glob("*.json"))
    biggest = max((p.stat().st_size for p in search), default=0)
    rep.check(biggest <= thresholds["warn_search_file_bytes"],
              f"가장 큰 검색 조각 {biggest / 1024:.1f}KB", warn_only=True)
    for key in meta.get("split_search_keys", []):
        rep.check((export_dir / "search" / f"{key}.json").exists(), f"나뉜 검색 키 {key} 자리 파일")


def validate_db(conn, previous_meta: dict | None = None, cases_path: Path | None = DEFAULT_CASES,
                export_dir: Path | None = None, thresholds: dict = THRESHOLDS) -> Report:
    rep = Report()
    check_product_count(conn, rep, previous_meta, thresholds)
    check_required_fields(conn, rep, thresholds)
    check_ingredients(conn, rep, thresholds)
    check_rule_refs(conn, rep, thresholds)
    check_import_drops(conn, rep, thresholds)
    check_cases(conn, rep, cases_path)
    if export_dir:
        check_export(rep, export_dir, thresholds)
    return rep


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.validate", description="새 데이터 검사")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_csv = sub.add_parser("csv", help="가져오기 전 CSV 폴더 검사")
    p_csv.add_argument("directory")
    p_db = sub.add_parser("db", help="가져온 DB(와 내보낸 조각) 검사")
    p_db.add_argument("--db", help="DB 파일 (기본: YAKSOK_DB 또는 data/yaksok.db)")
    p_db.add_argument("--previous-meta", help="지금 배포 중인 meta.json (품목 수 비교용)")
    p_db.add_argument("--export-dir", help="새로 내보낸 data 폴더")
    p_db.add_argument("--cases", default=str(DEFAULT_CASES))
    for p in (p_csv, p_db):
        p.add_argument("--report", help="결과를 마크다운으로 저장할 파일")
        p.add_argument("--thresholds", help="한도를 바꿀 JSON 파일 (THRESHOLDS 의 키)")
    args = parser.parse_args(argv)

    thresholds = dict(THRESHOLDS)
    if args.thresholds:
        thresholds.update(json.loads(Path(args.thresholds).read_text(encoding="utf-8")))

    if args.cmd == "csv":
        rep = validate_csv(Path(args.directory), thresholds)
    else:
        prev = None
        if args.previous_meta and Path(args.previous_meta).exists():
            prev = json.loads(Path(args.previous_meta).read_text(encoding="utf-8"))
        conn = connect(args.db)
        rep = validate_db(conn, prev, Path(args.cases) if args.cases else None,
                          Path(args.export_dir) if args.export_dir else None, thresholds)

    text = rep.markdown()
    print(text)
    if args.report:
        Path(args.report).write_text(text, encoding="utf-8")
    return 0 if rep.ok else 1


if __name__ == "__main__":
    sys.exit(main())
