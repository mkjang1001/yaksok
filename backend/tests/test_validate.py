"""데이터 검사 (app.validate)."""
import json
import shutil

from app import validate
from app.db import SAMPLE_DIR
from app.export_static import export
from app.rules import Checker
from app.validate import DEFAULT_CASES, load_cases, run_case, validate_csv, validate_db


def public_meta(products):
    return {"dataset": "public", "counts": {"products": products}}


def test_sample_data_passes(conn, tmp_path):
    out = tmp_path / "data"
    export(conn, out)
    rep = validate_db(conn, previous_meta=None, export_dir=out)
    assert rep.ok, rep.markdown()
    assert any("회귀 케이스 10개 통과" in m for m in rep.info)


def test_product_drop_over_5_percent_fails(conn):
    assert validate_db(conn, public_meta(17)).ok
    assert validate_db(conn, public_meta(17.5)).ok       # 2.9% 감소는 통과
    rep = validate_db(conn, public_meta(20))              # 15% 감소
    assert not rep.ok and any("품목 수 20 → 17" in e for e in rep.errors)


def test_drop_check_skipped_when_previous_was_sample(conn):
    rep = validate_db(conn, {"dataset": "sample", "counts": {"products": 1000}})
    assert rep.ok


def test_missing_required_fields(conn):
    conn.execute("UPDATE drug_product SET company = NULL WHERE item_seq IN ('S000000001', 'S000000002')")
    rep = validate_db(conn)
    assert any("'company' 빈 비율 11.8%" in e for e in rep.errors)


def test_products_without_ingredients(conn):
    conn.execute("DELETE FROM product_ingredient WHERE item_seq IN "
                 "('S000000001','S000000002','S000000003','S000000004')")
    rep = validate_db(conn)
    assert any(e.startswith("성분 없는 품목 4개") for e in rep.errors)


def test_rule_pointing_to_missing_ingredient(conn):
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("INSERT INTO dur_rule (type, ingr_a) VALUES ('ELDERLY', 'NOPE')")
    rep = validate_db(conn)
    assert any("성분표에 없는 성분코드를 가리키는 규칙 1개" in e for e in rep.errors)


def test_regression_case_failure_reported(conn, tmp_path):
    cases = load_cases(DEFAULT_CASES)
    cases[1]["expect"]["rules"] = ["R2"]
    path = tmp_path / "cases.json"
    path.write_text(json.dumps({"cases": cases}, ensure_ascii=False), encoding="utf-8")
    rep = validate_db(conn, cases_path=path)
    assert any("회귀 케이스 '병용금기' 실패" in e for e in rep.errors)


def test_cases_match_python_tests(conn):
    """JSON 케이스는 tests/test_rules.py 와 같은 기대값이다. 모두 통과해야 한다."""
    checker = Checker(conn, strict_approval=False)
    for case in load_cases(DEFAULT_CASES):
        assert run_case(checker, case) == [], case["name"]


def test_public_dataset_runs_only_generic_cases(conn):
    conn.execute("UPDATE meta SET value = 'public' WHERE key = 'dataset'")
    rep = validate_db(conn)
    assert any("회귀 케이스 2개 통과" in m for m in rep.info)


def test_csv_check_catches_dangling_references(tmp_path):
    src = tmp_path / "csv"
    shutil.copytree(SAMPLE_DIR, src)
    assert validate_csv(src).ok
    with (src / "dur_rules.csv").open("a", encoding="utf-8") as f:
        for i in range(10):
            f.write(f"COMBO_TABOO,X{i},Y{i},,,,테스트,\n")
    rep = validate_csv(src)
    assert not rep.ok and any("성분표에 없는 성분코드를 가리키는 규칙 10개 / 18개" in e for e in rep.errors)


def test_cli_exit_codes(conn, tmp_path, capsys):
    db = tmp_path / "test.db"  # conftest 의 conn 이 만든 DB
    conn.commit()
    report = tmp_path / "r.md"
    assert validate.main(["db", "--db", str(db), "--report", str(report)]) == 0
    assert "데이터 검사 통과" in report.read_text(encoding="utf-8")
    prev = tmp_path / "meta.json"
    prev.write_text(json.dumps(public_meta(100)), encoding="utf-8")
    assert validate.main(["db", "--db", str(db), "--previous-meta", str(prev)]) == 1
    assert validate.main(["csv", str(SAMPLE_DIR)]) == 0
