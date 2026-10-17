"""약 이름 검색 (F1). 완전 일치 → 앞부분 일치 → 포함 → 초성 → 자모 유사도(오타 허용) 순으로 점수를 매긴다."""
import re
import sqlite3
from dataclasses import dataclass

from .hangul import best_window_similarity, decompose, is_chosung_query, normalize

FUZZY_THRESHOLD = 0.72
_DOSE = re.compile(r"\d+(?:\.\d+)?\s*(mg|㎎|mcg|㎍|g|ml|㎖)", re.IGNORECASE)


@dataclass
class IndexedDrug:
    item_seq: str
    name: str
    norm: str
    jamo: str
    chosung: str
    stem: str  # 함량을 뺀 이름 (사진 인식 줄에 이름이 통째로 들어 있는지 볼 때 쓴다)


class DrugIndex:
    """검색용 메모리 색인. DB를 다시 가져오면 reload()를 부른다."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self.items: list[IndexedDrug] = []
        self.reload()

    def reload(self) -> None:
        rows = self.conn.execute("SELECT item_seq, name, name_norm, name_chosung FROM drug_product").fetchall()
        self.items = [
            IndexedDrug(r["item_seq"], r["name"], r["name_norm"], decompose(r["name_norm"]), r["name_chosung"],
                        normalize(_DOSE.sub("", r["name"])))
            for r in rows
        ]

    def score(self, query: str) -> list[tuple[float, IndexedDrug]]:
        q = normalize(query)
        if not q:
            return []
        scored = []
        if is_chosung_query(q):
            for d in self.items:
                if d.chosung.startswith(q):
                    scored.append((0.85, d))
                elif q in d.chosung:
                    scored.append((0.75, d))
            return scored

        q_jamo = decompose(q)
        for d in self.items:
            if d.norm == q:
                s = 1.0
            elif d.norm.startswith(q):
                s = 0.95
            elif q in d.norm:
                s = 0.88
            elif len(d.stem) >= 3 and d.stem in q:
                s = 0.9  # 긴 줄(사진 인식) 안에 약 이름이 통째로 있음
            elif len(q) >= 2:
                sim = best_window_similarity(q_jamo, d.jamo)
                s = 0.5 + 0.35 * sim if sim >= FUZZY_THRESHOLD else 0.0
            else:
                s = 0.0
            if s > 0:
                scored.append((s, d))
        return scored

    def search(self, query: str, limit: int = 10) -> list[tuple[float, str]]:
        scored = self.score(query)
        scored.sort(key=lambda x: (-x[0], len(x[1].name), x[1].name))
        return [(round(s, 3), d.item_seq) for s, d in scored[:limit]]


def product_summaries(conn: sqlite3.Connection, item_seqs: list[str]) -> dict[str, dict]:
    if not item_seqs:
        return {}
    marks = ",".join("?" * len(item_seqs))
    rows = conn.execute(
        f"""SELECT item_seq, name, company, is_otc, easy_category, easy_efficacy, pill_shape, pill_color,
                   pill_image_url, data_date, is_sample
            FROM drug_product WHERE item_seq IN ({marks})""",
        item_seqs,
    ).fetchall()
    ingr_rows = conn.execute(
        f"""SELECT pi.item_seq, i.ingr_code, i.name_ko, i.name_en, pi.amount
            FROM product_ingredient pi JOIN ingredient i ON i.ingr_code = pi.ingr_code
            WHERE pi.item_seq IN ({marks}) ORDER BY i.name_ko""",
        item_seqs,
    ).fetchall()
    ingredients: dict[str, list] = {}
    for r in ingr_rows:
        ingredients.setdefault(r["item_seq"], []).append(
            {"code": r["ingr_code"], "name": r["name_ko"], "name_en": r["name_en"], "amount": r["amount"]}
        )
    out = {}
    for r in rows:
        out[r["item_seq"]] = {
            "item_seq": r["item_seq"],
            "name": r["name"],
            "company": r["company"],
            "is_otc": bool(r["is_otc"]),
            "category": r["easy_category"],
            "efficacy": r["easy_efficacy"],
            "pill": {"shape": r["pill_shape"], "color": r["pill_color"], "image_url": r["pill_image_url"]},
            "ingredients": ingredients.get(r["item_seq"], []),
            "data_date": r["data_date"],
            "is_sample": bool(r["is_sample"]),
        }
    return out
