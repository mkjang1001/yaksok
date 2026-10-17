import json
import shutil
from pathlib import Path

import pytest

from app import export_static
from app.db import SAMPLE_DIR, connect, import_dir, init_schema
from app.export_static import bucket, export, fnv1a, search_key, split_search_shards


def test_hash_matches_known_values():
    # src/lib/shard.ts 테스트와 같은 값이어야 한다
    assert fnv1a("") == 0x811C9DC5
    assert fnv1a("a") == 0xE40C292C
    assert bucket("S000000001", 256) == f"{fnv1a('S000000001') % 256:02x}"


def test_search_key():
    assert search_key("에소메프라졸정20mg") == "3147-3145"
    assert search_key("에") is None


def test_export_writes_small_shards(conn, tmp_path):
    out = tmp_path / "data"
    summary = export(conn, out)
    assert summary["counts"]["products"] == 17
    meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
    assert meta["dataset"] == "sample"

    # 검색 조각: 'ㅇㅅ'으로 시작하는 약만 들어 있다
    rows = json.loads((out / "search" / "3147-3145.json").read_text(encoding="utf-8"))
    names = {r[1] for r in rows}
    assert "에소메프라졸정 20mg" in names and "아세트아미노펜정 500mg" in names
    assert "암로디핀정 5mg" not in names

    # 품목 조각에서 상세를 찾을 수 있다
    drug = json.loads((out / "drug" / f"{bucket('S000000101', 256)}.json").read_text(encoding="utf-8"))
    assert [i["name"] for i in drug["S000000101"]["ingredients"]] == ["슈도에페드린", "아세트아미노펜", "클로르페니라민"]

    # 병용금기는 양쪽 성분에 모두 적혀 있다
    def rule(code):
        return json.loads((out / "rule" / f"{bucket(code, 64)}.json").read_text(encoding="utf-8"))[code]
    assert rule("SI09")["combo"][0]["with"] == "SI04"
    assert rule("SI04")["combo"][0]["with"] == "SI09"
    assert rule("SI12")["elderly"] is not None
    assert rule("SI05")["groups"][0]["name"] == "위산 억제제"


def test_search_key_three_chars():
    assert search_key("에소메프라졸", 3) == "3147-3145-3141"
    assert search_key("에소", 3) is None


def test_big_search_shard_is_split_by_three_chars():
    rows = lambda prefix, n: [(f"{prefix}{i}", [f"S{i}", f"{prefix}{i}", None, None, None, None]) for i in range(n)]
    entries = rows("에소메", 3) + rows("에소프", 2) + [("에소", ["S9", "에소", None, None, None, None])]
    files, children = split_search_shards({"3147-3145": entries, "3131-3131": rows("가가", 1)}, limit=100)
    assert children == {"3147-3145": ["3147-3145-3141", "3147-3145-314d"]}
    assert [r[1] for r in files["3147-3145"]] == ["에소"]  # 세 글자 키를 못 만드는 짧은 이름만 남는다
    assert len(files["3147-3145-3141"]) == 3 and len(files["3147-3145-314d"]) == 2
    assert files["3131-3131"][0][1] == "가가0"  # 작은 조각은 그대로


def test_split_keys_recorded_in_meta(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(export_static, "SEARCH_SPLIT_BYTES", 200)
    out = tmp_path / "data"
    meta = export(conn, out)
    assert "3147-3145" in meta["split_search_keys"]
    children = meta["search_children"]["3147-3145"]
    # 두 글자 파일은 배열로 남아 지금 웹앱이 받아도 깨지지 않는다
    placeholder = json.loads((out / "search" / "3147-3145.json").read_text(encoding="utf-8"))
    assert isinstance(placeholder, list)
    names = {r[1] for key in children
             for r in json.loads((out / "search" / f"{key}.json").read_text(encoding="utf-8"))}
    assert "에소메프라졸정 20mg" in names and "아세트아미노펜정 500mg" in names
    assert json.loads((out / "meta.json").read_text(encoding="utf-8"))["split_search_keys"] == meta["split_search_keys"]


def test_insurance_codes_exported(tmp_path):
    src = tmp_path / "csv"
    shutil.copytree(SAMPLE_DIR, src)
    products = (src / "products.csv").read_text(encoding="utf-8").splitlines()
    products[0] += ",insurance_codes"
    products[1] += ",641900010;641900011"
    products[2:] = [line + "," for line in products[2:]]
    (src / "products.csv").write_text("\n".join(products) + "\n", encoding="utf-8")
    c = connect(tmp_path / "t.db")
    init_schema(c)
    summary = import_dir(c, src, is_sample=True)
    assert summary["insurance_codes"] == 2
    out = tmp_path / "data"
    meta = export(c, out)
    assert meta["shards"]["insurance"] == 256
    assert len(list((out / "insurance").glob("*.json"))) == 256
    seq = products[1].split(",")[0]
    for code in ("641900010", "641900011"):
        shard = json.loads((out / "insurance" / f"{bucket(code, 256)}.json").read_text(encoding="utf-8"))
        assert shard[code] == seq


def test_import_skips_dangling_rows(tmp_path):
    src = tmp_path / "csv"
    shutil.copytree(SAMPLE_DIR, src)
    with (src / "dur_rules.csv").open("a", encoding="utf-8") as f:
        f.write("ELDERLY,NOPE,,,,없는 성분,테스트,2026-10-13\n")
    with (src / "barcodes.csv").open("a", encoding="utf-8") as f:
        f.write("8800000009999,S999999999\n")
    c = connect(tmp_path / "t.db")
    init_schema(c)
    summary = import_dir(c, src, is_sample=True)
    assert summary["dropped"] == {"product_ingredients": 0, "barcodes": 1, "dur_rules": 1}


FRONTEND_DATA = Path(__file__).resolve().parents[2] / "frontend" / "public" / "data"


def test_sample_export_matches_committed_frontend_data(conn, tmp_path):
    """웹앱 테스트가 읽는 샘플 조각과 지금 내보내기 결과가 같아야 한다 (meta.json 은 키 추가만 허용)."""
    committed_meta = FRONTEND_DATA / "meta.json"
    if not committed_meta.exists():
        pytest.skip("frontend/public/data 없음")
    old_meta = json.loads(committed_meta.read_text(encoding="utf-8"))
    if old_meta.get("dataset") != "sample":
        pytest.skip("배포 데이터가 이미 실제 데이터로 바뀜")
    out = tmp_path / "data"
    new_meta = export(conn, out)
    for p in FRONTEND_DATA.rglob("*.json"):
        rel = p.relative_to(FRONTEND_DATA)
        if rel.as_posix() == "meta.json":
            continue
        assert (out / rel).read_bytes() == p.read_bytes(), rel
    for key, value in old_meta.items():
        if key == "generated_at":
            continue
        if isinstance(value, dict):
            assert {k: new_meta[key][k] for k in value} == value, key
        else:
            assert new_meta[key] == value, key
