"""실제 규모 대비: 가짜 품목 3만 개로 가져오기·내보내기. 측정값은 README "실제 규모 측정"에 적어 둔다.

YAKSOK_SCALE_N 으로 품목 수를 바꿀 수 있다 (기본 30000).
"""
import json
import os

from app.fake_data import measure
from app.validate import THRESHOLDS

N = int(os.environ.get("YAKSOK_SCALE_N", "30000"))


def test_scale_export(tmp_path):
    m = measure(N, tmp_path)
    print(json.dumps(m, ensure_ascii=False))
    assert m["files"] < THRESHOLDS["max_files"]   # Cloudflare Pages 2만 파일 한도
    assert m["seconds"]["export"] < 120
    assert m["by_kind"]["drug"]["max_kb"] < 200

    out = tmp_path / "data"
    meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
    assert meta["counts"]["products"] == N
    assert meta["split_search_keys"], "복제약이 몰린 키는 나뉘어야 한다"

    # 나눈 뒤에도 검색 줄은 빠짐없이 정확히 한 번씩 들어 있다
    seen = []
    for p in (out / "search").glob("*.json"):
        rows = json.loads(p.read_text(encoding="utf-8"))
        assert isinstance(rows, list)
        seen += [r[0] for r in rows]
    assert len(seen) == len(set(seen)) == N

    # 두 글자 자리 파일은 작다 (세 글자 키를 못 만드는 짧은 이름만)
    for key in meta["split_search_keys"]:
        assert (out / "search" / f"{key}.json").stat().st_size < 10 * 1024
        assert all((out / "search" / f"{c}.json").exists() for c in meta["search_children"][key])

    # 보험코드 조각
    assert meta["counts"]["insurance_files"] == 256
