"""SQLite 연결, 스키마 생성, CSV 가져오기.

가져오기 CSV 형식은 data/sample/ 의 파일과 같다. 공공데이터 수집 스크립트(datagokr.py)도
이 형식으로 CSV를 만든 뒤 같은 함수로 넣는다.
"""
import csv
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from . import config
from .hangul import chosung, normalize

SCHEMA_PATH = Path(__file__).with_name("schema.sql")
TEMPLATES_PATH = config.BASE_DIR / "data" / "templates.json"
SAMPLE_DIR = config.BASE_DIR / "data" / "sample"

RULE_VERSION = "2026.10.1"


def connect(path: Path | str | None = None) -> sqlite3.Connection:
    path = Path(path or config.DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    conn.commit()


def _read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8-sig", newline="") as f:
        return [{k: (v.strip() if isinstance(v, str) else v) for k, v in row.items()} for row in csv.DictReader(f)]


def _blank_to_none(value):
    return value if value not in ("", None) else None


def import_dir(conn: sqlite3.Connection, directory: Path, is_sample: bool, replace: bool = True) -> dict:
    """products / ingredients / product_ingredients / barcodes / dur_rules CSV를 넣는다."""
    directory = Path(directory)
    products = _read_csv(directory / "products.csv")
    ingredients = _read_csv(directory / "ingredients.csv")
    links = _read_csv(directory / "product_ingredients.csv")
    barcodes = _read_csv(directory / "barcodes.csv")
    rules = _read_csv(directory / "dur_rules.csv")
    flag = 1 if is_sample else 0

    with conn:
        if replace:
            for table in ("dur_rule", "drug_barcode", "product_ingredient", "ingredient", "drug_product"):
                conn.execute(f"DELETE FROM {table}")
        conn.executemany(
            "INSERT OR REPLACE INTO ingredient (ingr_code, name_ko, name_en) VALUES (?, ?, ?)",
            [(r["ingr_code"], r["name_ko"], _blank_to_none(r.get("name_en"))) for r in ingredients],
        )
        conn.executemany(
            """INSERT OR REPLACE INTO drug_product
               (item_seq, name, name_norm, name_chosung, company, is_otc, easy_category, easy_efficacy,
                pill_shape, pill_color, pill_image_url, data_date, is_sample)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    r["item_seq"], r["name"], normalize(r["name"]), chosung(normalize(r["name"])),
                    _blank_to_none(r.get("company")), int(r.get("is_otc") or 0),
                    _blank_to_none(r.get("easy_category")), _blank_to_none(r.get("easy_efficacy")),
                    _blank_to_none(r.get("pill_shape")), _blank_to_none(r.get("pill_color")),
                    _blank_to_none(r.get("pill_image_url")), _blank_to_none(r.get("data_date")), flag,
                )
                for r in products
            ],
        )
        conn.executemany(
            "INSERT OR REPLACE INTO product_ingredient (item_seq, ingr_code, amount) VALUES (?, ?, ?)",
            [(r["item_seq"], r["ingr_code"], _blank_to_none(r.get("amount"))) for r in links],
        )
        conn.executemany(
            "INSERT OR REPLACE INTO drug_barcode (barcode, item_seq) VALUES (?, ?)",
            [(r["barcode"], r["item_seq"]) for r in barcodes],
        )
        conn.executemany(
            """INSERT INTO dur_rule (type, ingr_a, ingr_b, group_code, group_name, detail, source, data_date, is_sample)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (
                    r["type"], r["ingr_a"], _blank_to_none(r.get("ingr_b")), _blank_to_none(r.get("group_code")),
                    _blank_to_none(r.get("group_name")), _blank_to_none(r.get("detail")),
                    _blank_to_none(r.get("source")), _blank_to_none(r.get("data_date")), flag,
                )
                for r in rules
            ],
        )
        data_dates = [r["data_date"] for r in products + rules if r.get("data_date")]
        set_meta(conn, "data_date", max(data_dates) if data_dates else None)
        set_meta(conn, "dataset", "sample" if is_sample else "public")
        set_meta(conn, "rule_version", RULE_VERSION)
        set_meta(conn, "imported_at", datetime.now(timezone.utc).isoformat(timespec="seconds"))

    return {
        "products": len(products), "ingredients": len(ingredients), "product_ingredients": len(links),
        "barcodes": len(barcodes), "dur_rules": len(rules),
    }


def load_templates(conn: sqlite3.Connection, path: Path = TEMPLATES_PATH) -> int:
    templates = json.loads(Path(path).read_text(encoding="utf-8"))
    with conn:
        conn.executemany(
            """INSERT OR REPLACE INTO message_template
               (rule_type, severity, title, body, question, tts_text, approved_by, approved_at, version)
               VALUES (:rule_type, :severity, :title, :body, :question, :tts_text, :approved_by, :approved_at, :version)""",
            templates,
        )
    return len(templates)


def set_meta(conn: sqlite3.Connection, key: str, value) -> None:
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value))


def get_meta(conn: sqlite3.Connection) -> dict:
    return {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM meta")}


def init_sample_db(path: Path | str | None = None) -> sqlite3.Connection:
    """빈 DB를 만들고 샘플 데이터와 문구를 넣는다. 테스트와 처음 실행에 쓴다."""
    conn = connect(path)
    init_schema(conn)
    import_dir(conn, SAMPLE_DIR, is_sample=True)
    load_templates(conn)
    return conn
