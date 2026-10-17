"""실제 규모 대비용 가짜 데이터. 품목 N개짜리 CSV 폴더를 만들고, 가져오기·내보내기를 재 본다.

  python -m app.fake_data 30000            가짜 3만 개로 측정 결과 출력 (임시 폴더 사용)

실제 품목 이름처럼 '성분명+제형+함량(업체)' 복제약이 많아서 앞 두 글자 초성이 몇몇 키에 몰린다.
"""
import csv
import json
import random
import sys
import tempfile
import time
from pathlib import Path

from .datagokr import CSV_COLUMNS

INGREDIENT_STEMS = [
    "아세트아미노펜", "아토르바스타틴", "암로디핀", "아스피린", "아목시실린", "알프라졸람", "에소메프라졸", "엔테카비르",
    "로수바스타틴", "로사르탄", "레바미피드", "레보세티리진", "리세드론산", "메트포르민", "모사프리드", "몬테루카스트",
    "발사르탄", "베포타스틴", "비소프롤롤", "세파클러", "세레콕시브", "시타글립틴", "심바스타틴", "실로스타졸",
    "오메프라졸", "올메사르탄", "이부프로펜", "이토프리드", "졸피뎀", "클로피도그렐", "클라리스로마이신", "타크로리무스",
    "탐스로신", "텔미사르탄", "트라마돌", "파모티딘", "펠루비프로펜", "프레가발린", "피나스테리드", "히드로클로로티아지드",
]
SYLLABLES = list("가나다라마바사아자차카타파하고노도로모보소오조코토포호구누두루무부수우주쿠투푸후기니디리미비시이지키티피히"
                 "게네데레메베세에제케테페헤그느드르므브스으즈크트프흐")
FORMS = ["정", "캡슐", "서방정", "필름코팅정", "시럽", "연질캡슐", "산", "주"]
COMPANIES = [f"가짜제약{c}" for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"] * 4 + [f"테스트약품{i}" for i in range(100)]
SHAPES = ["round", "oval", "capsule"]
COLORS = ["#ffffff", "#f5d742", "#f4a7b9", "#4a7bd0", "#e05252"]


def _zipf_choice(rng: random.Random, items: list, s: float = 1.1):
    weights = [1 / (i + 1) ** s for i in range(len(items))]
    return rng.choices(items, weights)[0]


def make_csvs(out_dir: Path, n: int, seed: int = 1, n_ingredients: int = 2000) -> dict:
    rng = random.Random(seed)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ingredients = [{"ingr_code": f"D{i:06d}",
                    "name_ko": INGREDIENT_STEMS[i] if i < len(INGREDIENT_STEMS) else
                    "".join(rng.choice(SYLLABLES) for _ in range(rng.randint(3, 6))),
                    "name_en": f"fake{i}"} for i in range(n_ingredients)]
    products, links, barcodes = [], [], []
    for k in range(n):
        seq = f"F{k:09d}"
        if rng.random() < 0.6:  # 복제약: 성분 이름으로 시작
            idx = rng.randrange(len(INGREDIENT_STEMS)) if rng.random() < 0.3 else \
                INGREDIENT_STEMS.index(_zipf_choice(rng, INGREDIENT_STEMS))
            stem, codes = INGREDIENT_STEMS[idx], [f"D{idx:06d}"]
        else:
            stem = "".join(rng.choice(SYLLABLES) for _ in range(rng.randint(2, 5)))
            codes = [f"D{rng.randrange(n_ingredients):06d}"]
        codes += [f"D{rng.randrange(n_ingredients):06d}" for _ in range(rng.choice([0, 0, 0, 1, 2]))]
        company = rng.choice(COMPANIES)
        name = f"{stem}{rng.choice(FORMS)} {rng.choice([5, 10, 20, 50, 100, 250, 500])}mg({company})"
        products.append({
            "item_seq": seq, "name": name, "company": company, "is_otc": str(int(rng.random() < 0.3)),
            "easy_category": "", "easy_efficacy": "가짜 효능 문구입니다." if rng.random() < 0.2 else "",
            "pill_shape": rng.choice(SHAPES), "pill_color": rng.choice(COLORS),
            "pill_image_url": f"https://example.invalid/img/{seq}.jpg" if rng.random() < 0.5 else "",
            "data_date": "2026-10-13", "insurance_codes": f"{600000000 + k:09d}",
        })
        for c in dict.fromkeys(codes):
            links.append({"item_seq": seq, "ingr_code": c, "amount": "10mg"})
        for b in range(rng.choice([1, 1, 2])):
            barcodes.append({"barcode": f"880{k:07d}{b:03d}", "item_seq": seq})
    rules = []
    for _ in range(n // 6):
        a, b = rng.sample(range(n_ingredients), 2)
        rules.append({"type": "COMBO_TABOO", "ingr_a": f"D{a:06d}", "ingr_b": f"D{b:06d}",
                      "detail": "가짜 병용금기", "source": "가짜", "data_date": "2026-10-13"})
    for i in rng.sample(range(n_ingredients), n_ingredients // 10):
        rules.append({"type": "ELDERLY", "ingr_a": f"D{i:06d}", "detail": "가짜 노인주의", "source": "가짜",
                      "data_date": "2026-10-13"})
    for i in rng.sample(range(n_ingredients), n_ingredients // 5):
        g = i % 50
        rules.append({"type": "EFFICACY_DUP", "ingr_a": f"D{i:06d}", "group_code": f"G{g:02d}",
                      "group_name": f"가짜 효능군 {g}", "source": "가짜", "data_date": "2026-10-13"})
    tables = {"products": products, "ingredients": ingredients, "product_ingredients": links,
              "barcodes": barcodes, "dur_rules": rules}
    for name, cols in CSV_COLUMNS.items():
        with (out_dir / f"{name}.csv").open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
            w.writeheader()
            w.writerows(tables[name])
    return {name: len(rows) for name, rows in tables.items()}


def measure(n: int, work_dir: Path) -> dict:
    """가짜 N개로 가져오기·내보내기 시간과 조각 크기를 잰다."""
    from .db import connect, import_dir, init_schema, load_templates
    from .export_static import export

    work_dir = Path(work_dir)
    t0 = time.perf_counter()
    make_csvs(work_dir / "csv", n)
    t1 = time.perf_counter()
    conn = connect(work_dir / "fake.db")
    init_schema(conn)
    import_dir(conn, work_dir / "csv", is_sample=False)
    load_templates(conn)
    t2 = time.perf_counter()
    summary = export(conn, work_dir / "data")
    t3 = time.perf_counter()
    conn.close()

    out = work_dir / "data"
    sizes: dict[str, list[int]] = {}
    for p in out.rglob("*.json"):
        kind = p.parent.name if p.parent != out else "root"
        sizes.setdefault(kind, []).append(p.stat().st_size)
    return {
        "products": n,
        "seconds": {"generate": round(t1 - t0, 2), "import": round(t2 - t1, 2), "export": round(t3 - t2, 2)},
        "files": sum(len(v) for v in sizes.values()),
        "total_mb": round(sum(sum(v) for v in sizes.values()) / 1024 / 1024, 1),
        "by_kind": {k: {"files": len(v), "max_kb": round(max(v) / 1024, 1),
                        "avg_kb": round(sum(v) / len(v) / 1024, 1)} for k, v in sorted(sizes.items())},
        "split_search_keys": len(summary["split_search_keys"]),
        "max_search_file_kb": round(summary["counts"]["max_search_file_bytes"] / 1024, 1),
    }


def main() -> None:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 30000
    with tempfile.TemporaryDirectory() as tmp:
        print(json.dumps(measure(n, Path(tmp)), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
