import pytest
from fastapi.testclient import TestClient

from app import main


@pytest.fixture
def client(tmp_path):
    main.state.clear()
    main.setup(tmp_path / "api.db")
    with TestClient(main.app) as c:
        yield c
    main.state["conn"].close()
    main.state.clear()


def test_search_and_detail(client):
    r = client.get("/api/drugs/search", params={"q": "암로"})
    assert r.status_code == 200
    first = r.json()["results"][0]
    assert first["name"] == "암로디핀정 5mg"
    assert first["ingredients"][0]["name"] == "암로디핀"
    assert client.get(f"/api/drugs/{first['item_seq']}").json()["category"] == "혈압약"
    assert client.get("/api/drugs/NOPE").status_code == 404


def test_barcode(client):
    assert client.get("/api/drugs/barcode/8800000000101").json()["category"] == "종합감기약"
    assert client.get("/api/drugs/barcode/0000").status_code == 404


def test_ocr_without_provider_returns_503(client):
    r = client.post("/api/ocr", files={"image": ("bag.jpg", b"\xff\xd8fake", "image/jpeg")})
    assert r.status_code == 503


def test_ocr_text(client):
    r = client.post("/api/ocr/text", json={"text": "셀레콕시브캡슐 200mg\n복용법 아침 저녁 식후 30분 총 14일분"})
    lines = r.json()["lines"]
    assert len(lines) == 1
    assert lines[0]["candidates"][0]["name"] == "셀레콕시브캡슐 200mg"


def test_check(client):
    r = client.post("/api/check", json={"age_band": "65+", "items": [
        {"item_seq": "S000000010", "received_from": "정형외과"},
        {"item_seq": "S000000102", "received_from": "약국에서 산 약"},
    ]})
    assert r.status_code == 200
    assert r.json()["findings"][0]["rule"] == "R2"
    assert client.post("/api/check", json={"age_band": "70", "items": []}).status_code == 422


def test_stats_roundtrip(client):
    body = {"org_code": "TEST01", "med_count": 8, "count_red": 1, "count_amber": 2, "count_grey": 1,
            "rule_types": ["R2", "R3", "R4", "R5"]}
    assert client.post("/api/stats", json=body).status_code == 204
    s = client.get("/api/stats/summary", params={"org_code": "TEST01"}).json()
    assert s == {"checks": 1, "meds": 8, "with_red": 1, "with_amber": 1}


def test_meta(client):
    m = client.get("/api/meta").json()
    assert m["dataset"] == "sample"
    assert m["templates"]["approved"] == 0
