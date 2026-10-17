"""DB 관리 명령.

  python -m app.cli init --sample        샘플 데이터로 DB 새로 만들기
  python -m app.cli import <폴더>          공공데이터에서 만든 CSV 폴더 가져오기 (샘플 대체)
  python -m app.cli templates             data/templates.json 문구 다시 넣기
  python -m app.cli info                  DB 상태 보기
"""
import argparse
from pathlib import Path

from . import config
from .db import SAMPLE_DIR, connect, get_meta, import_dir, init_schema, load_templates


def main() -> None:
    parser = argparse.ArgumentParser(prog="app.cli")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_init = sub.add_parser("init")
    p_init.add_argument("--sample", action="store_true")
    p_imp = sub.add_parser("import")
    p_imp.add_argument("directory")
    sub.add_parser("templates")
    sub.add_parser("info")
    args = parser.parse_args()

    if args.cmd == "init":
        if config.DB_PATH.exists():
            config.DB_PATH.unlink()
        conn = connect()
        init_schema(conn)
        if args.sample:
            print("샘플 데이터:", import_dir(conn, SAMPLE_DIR, is_sample=True))
        print("문구:", load_templates(conn), "개")
    elif args.cmd == "import":
        conn = connect()
        init_schema(conn)
        print("가져옴:", import_dir(conn, Path(args.directory), is_sample=False))
    elif args.cmd == "templates":
        conn = connect()
        init_schema(conn)
        print("문구:", load_templates(conn), "개")
    elif args.cmd == "info":
        conn = connect()
        for table in ("drug_product", "ingredient", "product_ingredient", "drug_barcode", "dur_rule",
                      "message_template", "stat_event"):
            print(f"{table:20s}", conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        print(get_meta(conn))
    print("DB:", config.DB_PATH)


if __name__ == "__main__":
    main()
