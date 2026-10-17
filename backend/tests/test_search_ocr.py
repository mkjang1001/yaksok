from app.hangul import chosung, decompose, josa, normalize
from app.ocr import match_lines, split_dose


def test_josa():
    assert josa("진통제", "과", "와") == "진통제와"
    assert josa("위장약", "과", "와") == "위장약과"
    assert josa("아세트아미노펜", "이", "가") == "아세트아미노펜이"
    assert josa("20mg", "은", "는") == "20mg은"
    assert josa("5ml", "으로", "로") == "5ml로"
    assert josa("ABC", "은", "는") == "ABC는"
    assert josa("10", "을", "를") == "10을"


def test_hangul_basics():
    assert normalize("에소메프라졸정 20 mg!") == "에소메프라졸정20mg"
    assert chosung("에소메") == "ㅇㅅㅁ"
    assert decompose("약") == "ㅇㅑㄱ"


def test_search_prefix_and_chosung(index):
    assert index.search("에소메")[0][1] in {"S000000005", "S000000006", "S000000007"}
    seqs = [s for _, s in index.search("ㅇㅅㅁ")]
    assert "S000000005" in seqs


def test_search_tolerates_typo(index):
    seqs = [s for _, s in index.search("에소메프라줄")]
    assert seqs and seqs[0] in {"S000000005", "S000000006", "S000000007"}


def test_search_ignores_unrelated(index):
    assert index.search("가나다라마바") == []


def test_split_dose():
    assert split_dose("라베프라졸정 10밀리그램")[1] == "10mg"
    assert split_dose("암로디핀정5㎎")[1] == "5mg"


def test_match_lines_prefers_dose_and_skips_noise(index):
    lines = [
        "OO약국 조제일자 2026.10.10",
        "에소메프라졸정 40mg 1일 1회",
        "아침 식후 30분 복용하세요 총 30일분",
        "라베프라졸정 10밀리그램",
    ]
    out = match_lines(index, lines)
    assert [m["candidates"][0]["item_seq"] for m in out] == ["S000000006", "S000000008"]
