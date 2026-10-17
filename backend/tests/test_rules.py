"""점검 엔진 회귀 테스트. 약사 검증 케이스가 생기면 여기에 추가한다 (설계서 B13)."""
from app.rules import Checker

DEMO = [  # 목업의 김순자 어르신 예시 + 이름 모르는 파스
    {"item_seq": "S000000001", "received_from": "OO내과"},
    {"item_seq": "S000000002", "received_from": "OO내과"},
    {"item_seq": "S000000003", "received_from": "OO내과"},
    {"item_seq": "S000000005", "received_from": "OO내과"},
    {"item_seq": "S000000010", "received_from": "정형외과"},
    {"item_seq": "S000000011", "received_from": "정형외과"},
    {"item_seq": "S000000008", "received_from": "정형외과"},
    {"item_seq": "S000000101", "received_from": "약국에서 산 약"},
    {"display_name": "파스(이름 모름)"},
]


def rules_of(result):
    return [f["rule"] for f in result["findings"]]


def test_demo_scenario(conn):
    r = Checker(conn, strict_approval=False).check("65+", DEMO)
    assert rules_of(r) == ["R2", "R3", "R4", "R5"]
    assert r["counts"] == {"red": 1, "amber": 2, "grey": 1}
    assert r["med_count"] == 9
    assert [u["display_name"] for u in r["unchecked"]] == ["파스(이름 모름)"]

    r2 = r["findings"][0]
    assert r2["severity"] == "red"
    assert set(r2["items"]) == {"S000000010", "S000000101"}
    assert r2["body"] == "정형외과 진통제와 약국에서 산 종합감기약에 모두 아세트아미노펜이 들어 있어요. 함께 드셔도 되는지 약사님께 여쭤보세요."

    r3 = r["findings"][1]
    assert r3["group"] == "위산 억제제"
    assert r3["body"].startswith("OO내과 위장약과 정형외과 위장약은 같은 종류")

    r4 = r["findings"][2]
    assert r4["ingredients"] == ["클로르페니라민"]
    assert r4["template"]["approved"] is False


def test_combo_taboo(conn):
    r = Checker(conn).check("65+", [
        {"item_seq": "S000000012", "received_from": "피부과"},
        {"item_seq": "S000000004", "received_from": "OO내과"},
    ])
    assert rules_of(r) == ["R1"]
    assert r["findings"][0]["severity"] == "red"
    assert r["findings"][0]["ingredients"] == ["이트라코나졸", "심바스타틴"]


def test_efficacy_dup_same_place_is_grey(conn):
    r = Checker(conn).check("under65", [
        {"item_seq": "S000000005", "received_from": "OO내과"},
        {"item_seq": "S000000008", "received_from": "OO내과"},
    ])
    assert rules_of(r) == ["R3_SAME"]
    assert r["findings"][0]["severity"] == "grey"
    # 받은 곳 이름이 같아 보이면 정식 약 이름으로 쓴다
    assert "에소메프라졸정 20mg과 라베프라졸정 10mg은" in r["findings"][0]["body"]


def test_efficacy_dup_unknown_place_is_amber(conn):
    r = Checker(conn).check("under65", [{"item_seq": "S000000011"}, {"item_seq": "S000000103"}])
    assert rules_of(r) == ["R3"]


def test_same_ingredient_not_reported_as_efficacy_dup(conn):
    r = Checker(conn).check("under65", [
        {"item_seq": "S000000005", "received_from": "OO내과"},
        {"item_seq": "S000000007", "received_from": "정형외과"},
    ])
    assert rules_of(r) == ["R2"]


def test_elderly_only_for_65_plus(conn):
    items = [{"item_seq": "S000000014", "received_from": "정신건강의학과"}]
    assert rules_of(Checker(conn).check("65+", items)) == ["R4"]
    assert rules_of(Checker(conn).check("under65", items)) == []


def test_duplicate_item_counted_once(conn):
    r = Checker(conn).check("under65", [{"item_seq": "S000000001"}, {"item_seq": "S000000001"}])
    assert r["med_count"] == 1
    assert r["findings"] == []


def test_polypharmacy_thresholds(conn):
    four = [{"display_name": f"약{i}"} for i in range(4)]
    assert rules_of(Checker(conn).check("65+", four)) == []
    ten = [{"display_name": f"약{i}"} for i in range(10)]
    r = Checker(conn).check("65+", ten)
    assert rules_of(r) == ["R5_PROGRAM"]
    assert r["findings"][0]["title"] == "약을 10개 드시고 계세요"


def test_strict_approval_hides_unapproved_text(conn):
    r = Checker(conn, strict_approval=True).check("65+", DEMO)
    assert all(f["title"] == "확인이 필요한 항목이 있어요" for f in r["findings"])
    conn.execute("UPDATE message_template SET approved_by = '테스트 약사', approved_at = '2026-10-17' WHERE rule_type = 'R2'")
    r = Checker(conn, strict_approval=True).check("65+", DEMO)
    assert r["findings"][0]["title"] == "같은 성분이 두 약에 들어 있어요"


def test_result_carries_versions(conn):
    r = Checker(conn).check("65+", DEMO)
    assert r["rule_version"] and r["data_date"] == "2026-10-13"
    assert r["dataset"] == "sample"
    assert all("evidence" in f for f in r["findings"])
