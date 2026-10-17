"""공공데이터 수집 (네트워크 없이 가짜 응답으로)."""
import json
import urllib.error
import urllib.parse

import pytest

from app import config, datagokr
from app.datagokr import ApiError, Fetcher, Tables, check_config, collect, map_rows, parse_response, write_csvs
from app.db import connect, import_dir, init_schema

INGR_PATTERN = r"\[(?P<ingr_code>[^\]]+)\]\s*(?P<name_ko>.*)"


def page(items, total, code="00"):
    return json.dumps({"header": {"resultCode": code, "resultMsg": "OK"},
                       "body": {"items": items, "totalCount": total}}).encode()


class FakeApi:
    """url 별 전체 행을 들고 있다가 pageNo/numOfRows 대로 잘라 준다. fail 에 실패를 차례로 넣는다."""

    def __init__(self, data, fail=None):
        self.data, self.fail, self.calls = data, list(fail or []), []

    def __call__(self, url, timeout):
        base, query = url.split("?", 1)
        q = dict(urllib.parse.parse_qsl(query))
        self.calls.append(q)
        if self.fail:
            err = self.fail.pop(0)
            if isinstance(err, bytes):
                return err
            raise err
        rows = self.data[base]
        n, p = int(q["numOfRows"]), int(q["pageNo"])
        return page(rows[(p - 1) * n: p * n], len(rows))


@pytest.fixture(autouse=True)
def key(monkeypatch):
    monkeypatch.setattr(config, "DATA_GO_KR_SERVICE_KEY", "abc%2Bdef%3D%3D")


def fetcher(api, **kw):
    return Fetcher(opener=api, sleep=lambda s: None, min_interval_sec=0, page_size=kw.pop("page_size", 2), **kw)


def test_pages_until_total_and_decodes_encoded_key():
    api = FakeApi({"https://x/a": [{"n": i} for i in range(5)]})
    rows = fetcher(api).fetch_all("https://x/a")
    assert [r["n"] for r in rows] == [0, 1, 2, 3, 4]
    assert [c["pageNo"] for c in api.calls] == ["1", "2", "3"]
    assert api.calls[0]["serviceKey"] == "abc+def=="  # 인코딩 키를 풀어서 한 번만 인코딩


def test_retries_temporary_errors():
    err503 = urllib.error.HTTPError("https://x/a", 503, "busy", {}, None)
    api = FakeApi({"https://x/a": [{"n": 1}]},
                  fail=[err503, TimeoutError(), b"not json", page([], 0, code="05")])
    assert fetcher(api).fetch_all("https://x/a") == [{"n": 1}]
    assert len(api.calls) == 5


def test_gives_up_after_max_retries():
    api = FakeApi({"https://x/a": []}, fail=[TimeoutError()] * 3)
    with pytest.raises(ApiError, match="2번 다시 했지만"):
        fetcher(api, max_retries=2).fetch_all("https://x/a")


def test_fatal_codes_do_not_retry():
    xml = (b"<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR"
           b"</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>")
    api = FakeApi({"https://x/a": []}, fail=[xml])
    with pytest.raises(ApiError, match="등록되지 않은 서비스키"):
        fetcher(api).fetch_all("https://x/a")
    assert len(api.calls) == 1
    with pytest.raises(ApiError, match="하루 호출 한도"):
        parse_response(page([], 0, code="22"))
    with pytest.raises(ApiError, match="HTTP 404"):
        fetcher(FakeApi({}, fail=[urllib.error.HTTPError("u", 404, "x", {}, None)])).fetch_all("https://x/a")


def test_no_data_and_item_wrapper():
    assert parse_response(page([], 0, code="03")) == ([], 0)
    wrapped = json.dumps({"response": {"header": {"resultCode": "00"},
                                       "body": {"items": {"item": {"A": 1}}, "totalCount": 1}}}).encode()
    assert parse_response(wrapped) == ([{"A": 1}], 1)


def test_transforms_explode_and_where():
    raw = [{"ITEM_SEQ": "1", "ITEM_NAME": "가정", "ETC_OTC_CODE": "일반의약품", "D": "20231201",
            "EDI": "641900010, 641900011", "BAR": "880A,880B", "ING": "[M1]가성분|[M2]나성분", "CANCEL": "정상"},
           {"ITEM_SEQ": "2", "ITEM_NAME": "취소약", "CANCEL": "취소"}]
    where = {"CANCEL": ["정상"]}
    prod = map_rows(raw, {"item_seq": "ITEM_SEQ", "is_otc": "ETC_OTC_CODE", "data_date": "D", "insurance_codes": "EDI"},
                    transforms={"is_otc": "otc_flag", "data_date": "date", "insurance_codes": "list"}, where=where)
    assert prod == [{"item_seq": "1", "is_otc": "1", "data_date": "2023-12-01", "insurance_codes": "641900010;641900011"}]
    bars = map_rows(raw, {"item_seq": "ITEM_SEQ"}, explode={"field": "BAR", "sep": ",", "as": "barcode"}, where=where)
    assert bars == [{"item_seq": "1", "barcode": "880A"}, {"item_seq": "1", "barcode": "880B"}]
    ings = map_rows(raw, {"item_seq": "ITEM_SEQ"}, where=where,
                    explode={"field": "ING", "sep": "|", "pattern": INGR_PATTERN})
    assert [(r["ingr_code"], r["name_ko"]) for r in ings] == [("M1", "가성분"), ("M2", "나성분")]
    shape = map_rows([{"S": "장방형", "F": "경질캡슐제"}, {"S": "원형", "F": "필름코팅정"}, {"S": "타원형"}],
                     {"pill_shape": ["S", "F"]}, transforms={"pill_shape": "shape"})
    assert [r["pill_shape"] for r in shape] == ["capsule", "round", "oval"]
    assert map_rows([{"C": "하양, 노랑"}], {"pill_color": "C"}, transforms={"pill_color": "color"}) == [{"pill_color": "#ffffff"}]
    assert map_rows([{"T": "<p>위염&amp;속쓰림</p>\n"}], {"easy_efficacy": "T"},
                    transforms={"easy_efficacy": "text"}) == [{"easy_efficacy": "위염&속쓰림"}]


def test_tables_merge_and_enrich_only():
    t = Tables()
    t.add("products", [{"item_seq": "1", "name": "가정", "easy_efficacy": ""}])
    t.add("products", [{"item_seq": "1", "name": "다른 이름", "easy_efficacy": "효능"},
                       {"item_seq": "9", "easy_efficacy": "허가 목록에 없는 약"}], enrich_only=True)
    assert t.rows["products"] == [{"item_seq": "1", "name": "가정", "easy_efficacy": "효능"}]


def test_collect_end_to_end_then_import(tmp_path):
    api = FakeApi({
        "https://x/permit": [
            {"ITEM_SEQ": "P1", "ITEM_NAME": "가나정 10mg", "ENTP_NAME": "가짜제약", "ETC_OTC_CODE": "전문의약품",
             "CHANGE_DATE": "20261001", "EDI_CODE": "641900010", "BAR_CODE": "8801,8802",
             "MAIN_ITEM_INGR": "[D1]가나성분"},
            {"ITEM_SEQ": "P2", "ITEM_NAME": "다라캡슐", "ENTP_NAME": "가짜제약", "ETC_OTC_CODE": "일반의약품",
             "CHANGE_DATE": "20260901", "EDI_CODE": "", "BAR_CODE": "", "MAIN_ITEM_INGR": "[D2]다라성분"},
        ],
        "https://x/easy": [{"itemSeq": "P2", "efcyQesitm": "<p>두통에 써요.</p>"}, {"itemSeq": "Z", "efcyQesitm": "x"}],
        "https://x/combo": [{"INGR_CODE": "D1", "INGR_KOR_NAME": "가나성분", "MIXTURE_INGR_CODE": "D2",
                             "MIXTURE_INGR_KOR_NAME": "다라성분", "PROHBT_CONTENT": "같이 쓰지 말 것",
                             "CHANGE_DATE": "20261005"}],
    })
    ingr_explode = {"field": "MAIN_ITEM_INGR", "sep": "|", "pattern": INGR_PATTERN}
    cfg = {"jobs": [
        {"name": "허가", "url": "https://x/permit", "outputs": [
            {"table": "products", "fields": {"item_seq": "ITEM_SEQ", "name": "ITEM_NAME", "company": "ENTP_NAME",
                                              "is_otc": "ETC_OTC_CODE", "data_date": "CHANGE_DATE",
                                              "insurance_codes": "EDI_CODE"},
             "transforms": {"is_otc": "otc_flag", "data_date": "date", "insurance_codes": "list"}},
            {"table": "barcodes", "fields": {"item_seq": "ITEM_SEQ"},
             "explode": {"field": "BAR_CODE", "sep": ",", "as": "barcode"}},
            {"table": "product_ingredients", "fields": {"item_seq": "ITEM_SEQ"}, "explode": ingr_explode},
            {"table": "ingredients", "fields": {}, "explode": ingr_explode},
        ]},
        {"name": "e약은요", "url": "https://x/easy", "outputs": [
            {"table": "products", "enrich_only": True, "fields": {"item_seq": "itemSeq", "easy_efficacy": "efcyQesitm"},
             "transforms": {"easy_efficacy": "text"}}]},
        {"name": "병용금기", "url": "https://x/combo", "table": "dur_rules",
         "fields": {"ingr_a": "INGR_CODE", "ingr_b": "MIXTURE_INGR_CODE", "detail": "PROHBT_CONTENT",
                    "data_date": "CHANGE_DATE"},
         "transforms": {"data_date": "date"}, "constants": {"type": "COMBO_TABOO", "source": "식약처 DUR 병용금기"}},
    ]}
    assert check_config(cfg) == []
    tables = collect(cfg, fetcher(api, page_size=100))
    counts = write_csvs(tables, tmp_path / "csv")
    assert counts == {"products": 2, "ingredients": 2, "product_ingredients": 2, "barcodes": 2, "dur_rules": 1}

    conn = connect(tmp_path / "t.db")
    init_schema(conn)
    summary = import_dir(conn, tmp_path / "csv", is_sample=False)
    assert summary["dropped"] == {"product_ingredients": 0, "barcodes": 0, "dur_rules": 0}
    assert summary["insurance_codes"] == 1
    p2 = conn.execute("SELECT is_otc, easy_efficacy, data_date FROM drug_product WHERE item_seq = 'P2'").fetchone()
    assert tuple(p2) == (1, "두통에 써요.", "2026-09-01")
    assert conn.execute("SELECT value FROM meta WHERE key = 'data_date'").fetchone()[0] == "2026-10-05"


def test_example_config_is_valid_but_not_runnable_yet():
    cfg = json.loads((config.BASE_DIR / "data" / "datagokr_config.example.json").read_text(encoding="utf-8"))
    problems = check_config(cfg)
    # 표·열·변환 이름은 모두 맞고, 남은 문제는 '명세 대조 전'과 자리표시뿐이다
    assert problems and all(("verified" in p) or ("자리표시" in p) for p in problems), problems
    for job in cfg["jobs"]:
        job["verified"] = True
    rest = check_config(cfg)
    assert rest and all("자리표시" in p for p in rest) and any("효능군" in p for p in rest)


def test_main_without_key_or_with_placeholders(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(config, "DATA_GO_KR_SERVICE_KEY", "")
    example = str(config.BASE_DIR / "data" / "datagokr_config.example.json")
    assert datagokr.main([example, str(tmp_path)]) == 2
    monkeypatch.setattr(config, "DATA_GO_KR_SERVICE_KEY", "k")
    assert datagokr.main([example, str(tmp_path)]) == 3
    assert "설정 파일을 먼저 고치세요" in capsys.readouterr().err
