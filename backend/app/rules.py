"""점검 규칙 엔진 (설계서 B5). 상태를 저장하지 않는 순수 계산이다.

R1 병용금기 · R2 같은 성분 중복 · R3 효능군 중복 · R4 노인주의 · R5 다제약물
모든 판정은 성분 단위로 하고, 결과에는 근거·데이터 기준일·규칙 버전을 붙인다.
"""
import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field

from . import config
from .db import RULE_VERSION, get_meta
from .hangul import josa
from .search import product_summaries

SEVERITY_ORDER = {"red": 0, "amber": 1, "grey": 2}
POLYPHARMACY_MIN = 5
PROGRAM_MIN = 10
PHARMACY_PLACES = ("약국", "약국 구매", "약국에서 산 약", "약국에서 삼")

FALLBACK = {
    "title": "확인이 필요한 항목이 있어요",
    "body": "이 목록을 약사·의사에게 보여 주고 함께 확인하세요.",
    "question": None,
    "tts_text": "확인이 필요한 항목이 있어요. 약사님께 목록을 보여 주세요.",
}


@dataclass
class Med:
    index: int
    item_seq: str
    place: str
    product: dict
    label: str = ""
    ingr_codes: list = field(default_factory=list)


def _label(product: dict, place: str) -> str:
    category = product.get("category") or product["name"]
    if not place:
        return category
    if place in PHARMACY_PLACES or "약국에서" in place:
        return f"약국에서 산 {category}"
    return f"{place} {category}"


def _pair_labels(meds: list[Med]) -> tuple[str, str]:
    """판정 문장에 넣을 두 약 이름. 둘이 같아 보이면 정식 이름을 쓴다."""
    a, b = meds[0], meds[1]
    la, lb = a.label, b.label
    if la == lb:
        la, lb = a.product["name"], b.product["name"]
    if len(meds) > 2:
        lb = f"{lb} 등 {len(meds) - 1}개 약"
    return la, lb


def _vars(a: str = "", b: str = "", ingredient: str = "", group: str = "", count: int = 0) -> dict:
    v = {"a": a, "b": b, "ingredient": ingredient, "group": group, "count": count}
    if a:
        v.update(a_wa=josa(a, "과", "와"), a_eun=josa(a, "은", "는"))
    if b:
        v.update(b_eun=josa(b, "은", "는"), b_eul=josa(b, "을", "를"))
    if ingredient:
        v.update(ingredient_i=josa(ingredient, "이", "가"), ingredient_eun=josa(ingredient, "은", "는"))
    return v


class Checker:
    def __init__(self, conn: sqlite3.Connection, strict_approval: bool | None = None):
        self.conn = conn
        self.strict = config.STRICT_APPROVAL if strict_approval is None else strict_approval

    def _templates(self) -> dict:
        return {r["rule_type"]: dict(r) for r in self.conn.execute("SELECT * FROM message_template")}

    def _finding(self, templates, rule_type, meds, variables, evidence, ingredients=None, group=None):
        t = templates[rule_type]
        approved = bool(t["approved_by"])
        text = t if (approved or not self.strict) else {**FALLBACK}
        render = lambda s: s.format_map(variables) if s else None  # noqa: E731
        return {
            "id": f"{rule_type}:" + "+".join(m.item_seq for m in meds) + (f":{group}" if group else ""),
            "rule": rule_type,
            "severity": t["severity"],
            "title": render(text["title"]),
            "body": render(text["body"]),
            "question": render(text["question"]),
            "tts_text": render(text["tts_text"]),
            "items": [m.item_seq for m in meds],
            "item_labels": [m.label for m in meds],
            "ingredients": ingredients or [],
            "group": group,
            "evidence": evidence,
            "template": {"rule_type": rule_type, "version": t["version"], "approved": approved},
        }

    def check(self, age_band: str, items: list[dict]) -> dict:
        seqs = [it.get("item_seq") for it in items if it.get("item_seq")]
        products = product_summaries(self.conn, list(dict.fromkeys(seqs)))

        meds: list[Med] = []
        unchecked = []
        seen = set()
        for idx, it in enumerate(items):
            seq = it.get("item_seq")
            place = (it.get("received_from") or "").strip()
            if seq and seq in products:
                if seq in seen:
                    continue
                seen.add(seq)
                p = products[seq]
                meds.append(Med(idx, seq, place, p, _label(p, place), [i["code"] for i in p["ingredients"]]))
            else:
                unchecked.append({
                    "index": idx,
                    "item_seq": seq,
                    "display_name": it.get("display_name") or seq or "이름 모르는 약",
                    "reason": "not_in_db" if seq else "no_code",
                })

        templates = self._templates()
        findings = []
        by_ingr: dict[str, list[Med]] = defaultdict(list)
        ingr_name = {}
        for m in meds:
            for ing in m.product["ingredients"]:
                by_ingr[ing["code"]].append(m)
                ingr_name[ing["code"]] = ing["name"]
        codes = list(by_ingr)
        marks = ",".join("?" * len(codes))

        if codes:
            # R1 병용금기
            done_pairs = set()
            for r in self.conn.execute(
                f"""SELECT * FROM dur_rule WHERE type = 'COMBO_TABOO'
                    AND ingr_a IN ({marks}) AND ingr_b IN ({marks})""", codes + codes,
            ):
                for ma in by_ingr[r["ingr_a"]]:
                    for mb in by_ingr[r["ingr_b"]]:
                        key = tuple(sorted((ma.item_seq, mb.item_seq)))
                        if ma is mb or key in done_pairs:
                            continue
                        done_pairs.add(key)
                        a, b = _pair_labels([ma, mb])
                        findings.append(self._finding(
                            templates, "R1", [ma, mb], _vars(a, b),
                            {"source": r["source"], "detail": r["detail"], "data_date": r["data_date"]},
                            ingredients=[ingr_name[r["ingr_a"]], ingr_name[r["ingr_b"]]],
                        ))

            # R2 같은 성분 중복
            for code, ms in by_ingr.items():
                if len(ms) < 2:
                    continue
                a, b = _pair_labels(ms)
                findings.append(self._finding(
                    templates, "R2", ms, _vars(a, b, ingredient=ingr_name[code]),
                    {"source": "품목-성분 정보", "detail": f"{ingr_name[code]} 성분이 {len(ms)}개 약에 들어 있음",
                     "data_date": max((m.product["data_date"] or "") for m in ms) or None},
                    ingredients=[ingr_name[code]],
                ))

            # R3 효능군 중복 — 받은 곳이 모두 같으면 의도된 처방일 수 있어 '참고'로 낮춘다
            groups: dict[str, dict] = {}
            for r in self.conn.execute(
                f"SELECT * FROM dur_rule WHERE type = 'EFFICACY_DUP' AND ingr_a IN ({marks})", codes,
            ):
                g = groups.setdefault(r["group_code"], {"name": r["group_name"], "rule": r, "meds": {}, "codes": set()})
                for m in by_ingr[r["ingr_a"]]:
                    g["meds"][m.item_seq] = m
                    g["codes"].add(r["ingr_a"])
            for gcode, g in groups.items():
                ms = list(g["meds"].values())
                if len(ms) < 2 or len(g["codes"]) < 2:
                    continue  # 성분이 하나뿐이면 R2가 이미 다룬다
                places = {m.place for m in ms}
                same_place = len(places) == 1 and "" not in places
                rule_type = "R3_SAME" if same_place else "R3"
                a, b = _pair_labels(ms)
                r = g["rule"]
                findings.append(self._finding(
                    templates, rule_type, ms, _vars(a, b, group=g["name"]),
                    {"source": r["source"], "detail": r["detail"], "data_date": r["data_date"]},
                    ingredients=sorted(ingr_name[c] for c in g["codes"]), group=g["name"],
                ))

            # R4 노인주의
            if age_band == "65+":
                for r in self.conn.execute(
                    f"SELECT * FROM dur_rule WHERE type = 'ELDERLY' AND ingr_a IN ({marks})", codes,
                ):
                    for m in by_ingr[r["ingr_a"]]:
                        name = ingr_name[r["ingr_a"]]
                        findings.append(self._finding(
                            templates, "R4", [m], _vars(m.label, ingredient=name),
                            {"source": r["source"], "detail": r["detail"], "data_date": r["data_date"]},
                            ingredients=[name],
                        ))

        # R5 다제약물 (점검하지 못한 약도 개수에는 넣는다)
        count = len(meds) + len(unchecked)
        if count >= POLYPHARMACY_MIN:
            rule_type = "R5_PROGRAM" if count >= PROGRAM_MIN else "R5"
            findings.append(self._finding(
                templates, rule_type, [], _vars(count=count),
                {"source": "약 개수", "detail": f"{count}개 (기준 {POLYPHARMACY_MIN}개 이상)", "data_date": None},
            ))

        findings.sort(key=lambda f: SEVERITY_ORDER[f["severity"]])
        meta = get_meta(self.conn)
        counts = {s: sum(1 for f in findings if f["severity"] == s) for s in SEVERITY_ORDER}
        return {
            "findings": findings,
            "unchecked": unchecked,
            "med_count": count,
            "counts": counts,
            "rule_version": meta.get("rule_version", RULE_VERSION),
            "data_date": meta.get("data_date"),
            "dataset": meta.get("dataset"),
            "strict_approval": self.strict,
        }
