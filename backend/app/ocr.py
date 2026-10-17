"""약 봉투 인식 (설계서 B7).

1) OCR 제공자에서 줄 단위 텍스트를 받는다 (이미지는 메모리에서만 쓰고 저장·로그하지 않는다).
2) 줄을 정규화하고 함량을 분리한다.
3) 약 사전과 맞춰 줄마다 후보 Top-3를 낸다. 최종 선택은 사람이 한다.
"""
import base64
import json
import re
import time
import urllib.request
import uuid

from . import config
from .hangul import normalize
from .search import DrugIndex

DOSE_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(mg|㎎|밀리그램|mcg|㎍|g|ml|㎖)", re.IGNORECASE)
# 약 봉투에 흔한, 약 이름이 아닌 줄
NOISE_WORDS = ("복용", "식후", "식전", "취침", "아침", "점심", "저녁", "약국", "조제", "처방", "환자",
               "보험", "전화", "주소", "일분", "투약", "총", "원", "합계", "약제비", "보관")
MIN_SCORE = 0.7


class OcrUnavailable(Exception):
    pass


def _post_json(url: str, payload: dict, headers: dict) -> dict:
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json", **headers}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _google(image: bytes) -> list[str]:
    if not config.GOOGLE_VISION_API_KEY:
        raise OcrUnavailable("GOOGLE_VISION_API_KEY가 없습니다.")
    data = _post_json(
        f"https://vision.googleapis.com/v1/images:annotate?key={config.GOOGLE_VISION_API_KEY}",
        {"requests": [{
            "image": {"content": base64.b64encode(image).decode()},
            "features": [{"type": "TEXT_DETECTION"}],
            "imageContext": {"languageHints": ["ko"]},
        }]},
        {},
    )
    text = (data.get("responses") or [{}])[0].get("fullTextAnnotation", {}).get("text", "")
    return text.splitlines()


def _clova(image: bytes) -> list[str]:
    if not (config.CLOVA_OCR_URL and config.CLOVA_OCR_SECRET):
        raise OcrUnavailable("CLOVA_OCR_URL / CLOVA_OCR_SECRET이 없습니다.")
    data = _post_json(
        config.CLOVA_OCR_URL,
        {"version": "V2", "requestId": str(uuid.uuid4()), "timestamp": int(time.time() * 1000),
         "images": [{"format": "jpg", "name": "bag", "data": base64.b64encode(image).decode()}]},
        {"X-OCR-SECRET": config.CLOVA_OCR_SECRET},
    )
    lines, cur = [], []
    for f in (data.get("images") or [{}])[0].get("fields", []):
        cur.append(f.get("inferText", ""))
        if f.get("lineBreak"):
            lines.append(" ".join(cur))
            cur = []
    if cur:
        lines.append(" ".join(cur))
    return lines


def recognize(image: bytes) -> list[str]:
    provider = config.OCR_PROVIDER
    if provider == "google":
        return _google(image)
    if provider == "clova":
        return _clova(image)
    raise OcrUnavailable("사진 인식 제공자가 설정되지 않았습니다. 봉투 글자를 직접 입력해 주세요.")


def split_dose(line: str) -> tuple[str, str | None]:
    m = DOSE_RE.search(line)
    dose = None
    if m:
        unit = m.group(2).lower().replace("㎎", "mg").replace("밀리그램", "mg").replace("㎍", "mcg").replace("㎖", "ml")
        dose = f"{m.group(1)}{unit}"
    return DOSE_RE.sub(" ", line), dose


def _is_noise(norm: str) -> bool:
    hangul = sum(1 for ch in norm if "가" <= ch <= "힣")
    if hangul < 2:
        return True
    return any(w in norm for w in NOISE_WORDS) and len(norm) > 12


def match_lines(index: DrugIndex, lines: list[str], top: int = 3) -> list[dict]:
    results = []
    for raw in lines:
        raw = raw.strip()
        if not raw:
            continue
        text, dose = split_dose(raw)
        norm = normalize(text)
        if _is_noise(norm):
            continue
        scored = index.score(text)
        boosted = []
        for s, d in scored:
            if dose and normalize(dose) in d.norm:
                s += 0.05
            if s >= MIN_SCORE:
                boosted.append((min(s, 1.0), d))
        boosted.sort(key=lambda x: (-x[0], len(x[1].name)))
        if boosted:
            results.append({
                "line": raw,
                "dose": dose,
                "candidates": [{"item_seq": d.item_seq, "score": round(s, 3)} for s, d in boosted[:top]],
            })
    return results
