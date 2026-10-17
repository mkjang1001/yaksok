import json

from app.export_static import bucket, export, fnv1a, search_key


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
