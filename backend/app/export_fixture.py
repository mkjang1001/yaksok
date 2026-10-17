"""웹앱 테스트용 샘플 조각 만들기.

    python -m app.export_fixture [대상 폴더]   (기본: frontend/src/lib/__fixtures__)

<대상>/sample        샘플 DB 내보내기 (export_static 과 같음)
<대상>/sample-split  SEARCH_SPLIT_BYTES=200 으로 내보내 검색 조각을 세 글자로 나눈 것

배포 데이터(frontend/public/data)는 실제 데이터로 바뀌므로, 웹앱 테스트는 이 폴더를 읽는다.
파일 수를 줄이려고 빈 해시 조각({})은 지운다 (테스트 로더는 없는 파일을 빈 조각으로 본다).
샘플 CSV·문구·내보내기 방식을 바꾸면 다시 실행해서 커밋한다
(tests/test_export_static.py 가 커밋된 픽스처와 바이트 단위로 비교한다).
"""
import shutil
import sys
import tempfile
from pathlib import Path

from app import export_static
from app.db import init_sample_db

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "__fixtures__"
SPLIT_BYTES = 200


def export_sample(out_dir: Path, split_bytes: int | None = None) -> dict:
    out_dir = Path(out_dir)
    with tempfile.TemporaryDirectory() as tmp:
        conn = init_sample_db(Path(tmp) / "sample.db")
        old = export_static.SEARCH_SPLIT_BYTES
        try:
            if split_bytes is not None:
                export_static.SEARCH_SPLIT_BYTES = split_bytes
            meta = export_static.export(conn, out_dir)
        finally:
            export_static.SEARCH_SPLIT_BYTES = old
            conn.close()
    for p in out_dir.glob("*/*.json"):
        if p.parent.name != "search" and p.read_text(encoding="utf-8").strip() == "{}":
            p.unlink()
    return meta


def main() -> None:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else FIXTURE_DIR
    for name, split in (("sample", None), ("sample-split", SPLIT_BYTES)):
        out = target / name
        if out.exists():
            shutil.rmtree(out)
        meta = export_sample(out, split)
        print(f"{out}: {meta['counts']['products']} products, split keys {meta['split_search_keys']}")


if __name__ == "__main__":
    main()
