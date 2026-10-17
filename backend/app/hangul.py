"""한글 처리: 자모 분해, 초성, 정규화, 조사 붙이기, 편집 거리."""
import re

CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"
JONG = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ",
        "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"]

_SYL_START, _SYL_END = 0xAC00, 0xD7A3
_KEEP = re.compile(r"[^0-9a-z가-힣ㄱ-ㆎ]")
# 숫자를 한글로 읽었을 때 받침이 있는지 (0 영, 1 일, 3 삼, 6 육, 7 칠, 8 팔)
_DIGIT_BATCHIM = {"0": True, "1": True, "2": False, "3": True, "4": False,
                  "5": False, "6": True, "7": True, "8": True, "9": False}


def is_syllable(ch: str) -> bool:
    return _SYL_START <= ord(ch) <= _SYL_END


def normalize(text: str) -> str:
    """검색·매칭용: 소문자, 공백과 특수문자 제거."""
    return _KEEP.sub("", text.lower())


def decompose(text: str) -> str:
    out = []
    for ch in text:
        if is_syllable(ch):
            code = ord(ch) - _SYL_START
            out.append(CHO[code // 588])
            out.append(JUNG[(code % 588) // 28])
            if code % 28:
                out.append(JONG[code % 28])
        else:
            out.append(ch)
    return "".join(out)


def chosung(text: str) -> str:
    out = []
    for ch in text:
        if is_syllable(ch):
            out.append(CHO[(ord(ch) - _SYL_START) // 588])
        else:
            out.append(ch)
    return "".join(out)


def is_chosung_query(text: str) -> bool:
    return bool(text) and all(ch in CHO for ch in text)


# 약 함량 단위를 읽었을 때의 받침 (밀리그램, 그램, 마이크로그램, 밀리리터)
_UNIT_BATCHIM = {"mcg": (True, False), "mg": (True, False), "ml": (True, True), "g": (True, False)}


def _last_batchim(word: str):
    """마지막 글자 받침 정보: None(판단 불가) 또는 (받침 있음, 받침이 ㄹ)."""
    lowered = word.strip().lower()
    for unit, info in _UNIT_BATCHIM.items():
        if lowered.endswith(unit) and lowered[: -len(unit)][-1:].isdigit():
            return info
    for ch in reversed(word.strip()):
        if is_syllable(ch):
            jong = (ord(ch) - _SYL_START) % 28
            return jong != 0, JONG[jong] == "ㄹ"
        if ch in _DIGIT_BATCHIM:
            return _DIGIT_BATCHIM[ch], ch in "178"
        if ch.isalpha():
            return False, False
    return None


def josa(word: str, with_batchim: str, without_batchim: str) -> str:
    """조사 붙이기. josa('진통제', '과', '와') -> '진통제와'"""
    info = _last_batchim(word)
    if info is None:
        return f"{word}{with_batchim}({without_batchim})"
    has, is_rieul = info
    if with_batchim == "으로" and is_rieul:
        return word + "로"
    return word + (with_batchim if has else without_batchim)


def levenshtein(a: str, b: str) -> int:
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def similarity(a: str, b: str) -> float:
    if not a and not b:
        return 1.0
    return 1.0 - levenshtein(a, b) / max(len(a), len(b))


def best_window_similarity(query_jamo: str, target_jamo: str) -> float:
    """target 안에서 query와 가장 비슷한 같은 길이 구간의 유사도 (오타 허용 부분 일치)."""
    n = len(query_jamo)
    if n == 0:
        return 0.0
    if len(target_jamo) <= n:
        return similarity(query_jamo, target_jamo)
    best = 0.0
    for start in range(len(target_jamo) - n + 1):
        s = similarity(query_jamo, target_jamo[start:start + n])
        if s > best:
            best = s
            if best == 1.0:
                break
    return best
