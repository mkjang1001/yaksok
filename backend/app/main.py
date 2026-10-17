"""약속 API 서버 (설계서 B9). 개인 약 목록을 저장하지 않는다."""
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config
from .db import connect, get_meta, init_sample_db, init_schema
from .ocr import OcrUnavailable, match_lines, recognize
from .rules import Checker
from .search import DrugIndex, product_summaries

state: dict = {}


def setup(db_path=None) -> None:
    path = Path(db_path or config.DB_PATH)
    if not path.exists():
        conn = init_sample_db(path)  # 처음 실행: 샘플 데이터로 시작
    else:
        conn = connect(path)
        init_schema(conn)
    state["conn"] = conn
    state["index"] = DrugIndex(conn)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if "conn" not in state:
        setup()
    yield


app = FastAPI(title="약속 API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def _conn():
    return state["conn"]


def _with_products(pairs: list[tuple[float, str]]) -> list[dict]:
    info = product_summaries(_conn(), [seq for _, seq in pairs])
    return [{**info[seq], "score": score} for score, seq in pairs if seq in info]


# ---------- 약 정보 ----------

@app.get("/api/drugs/search")
def search_drugs(q: str, limit: int = 10):
    if len(q.strip()) == 0:
        return {"query": q, "results": []}
    return {"query": q, "results": _with_products(state["index"].search(q, min(limit, 30)))}


@app.get("/api/drugs/barcode/{code}")
def drug_by_barcode(code: str):
    row = _conn().execute("SELECT item_seq FROM drug_barcode WHERE barcode = ?", (code.strip(),)).fetchone()
    if not row:
        raise HTTPException(404, "이 바코드의 약을 찾지 못했어요. 이름으로 찾아 주세요.")
    return product_summaries(_conn(), [row["item_seq"]])[row["item_seq"]]


@app.get("/api/drugs/{item_seq}")
def drug_detail(item_seq: str):
    info = product_summaries(_conn(), [item_seq])
    if item_seq not in info:
        raise HTTPException(404, "약 정보를 찾지 못했어요.")
    return info[item_seq]


# ---------- 사진 인식 ----------

class OcrTextIn(BaseModel):
    text: str = Field(max_length=5000)


def _ocr_response(lines: list[str]) -> dict:
    matches = match_lines(state["index"], lines)
    info = product_summaries(_conn(), [c["item_seq"] for m in matches for c in m["candidates"]])
    for m in matches:
        m["candidates"] = [{**info[c["item_seq"]], "score": c["score"]} for c in m["candidates"]]
    return {"lines": matches, "line_count": len(lines)}


@app.post("/api/ocr")
async def ocr_image(image: UploadFile = File(...)):
    data = await image.read(config.MAX_UPLOAD_BYTES + 1)
    if len(data) > config.MAX_UPLOAD_BYTES:
        raise HTTPException(413, "사진이 너무 커요. 다시 찍어 주세요.")
    try:
        lines = recognize(data)
    except OcrUnavailable as e:
        raise HTTPException(503, str(e))
    except Exception:
        raise HTTPException(502, "사진 인식에 실패했어요. 다시 찍거나 이름으로 찾아 주세요.")
    finally:
        del data  # 이미지는 어디에도 저장하지 않는다
    return _ocr_response(lines)


@app.post("/api/ocr/text")
def ocr_text(body: OcrTextIn):
    """사진 인식 제공자가 없을 때: 봉투 글자를 직접 입력해 같은 매칭을 쓴다."""
    return _ocr_response(body.text.splitlines())


# ---------- 점검 ----------

class CheckItem(BaseModel):
    item_seq: str | None = None
    display_name: str | None = Field(default=None, max_length=100)
    received_from: str | None = Field(default=None, max_length=50)


class CheckIn(BaseModel):
    age_band: Literal["65+", "under65"] = "65+"
    items: list[CheckItem] = Field(max_length=60)


@app.post("/api/check")
def check(body: CheckIn):
    return Checker(_conn()).check(body.age_band, [i.model_dump() for i in body.items])


# ---------- 익명 통계 ----------

class StatIn(BaseModel):
    org_code: str = Field(min_length=1, max_length=40)
    med_count: int = Field(ge=0, le=100)
    count_red: int = Field(ge=0, le=100)
    count_amber: int = Field(ge=0, le=100)
    count_grey: int = Field(ge=0, le=100)
    rule_types: list[str] = Field(default_factory=list, max_length=20)


@app.post("/api/stats", status_code=204)
def post_stat(body: StatIn):
    with _conn() as c:
        c.execute(
            """INSERT INTO stat_event (org_code, event_date, med_count, count_red, count_amber, count_grey,
                                       rule_types, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (body.org_code.strip(), date.today().isoformat(), body.med_count, body.count_red, body.count_amber,
             body.count_grey, ",".join(sorted(set(body.rule_types))),
             datetime.now(timezone.utc).isoformat(timespec="seconds")),
        )


@app.get("/api/stats/summary")
def stat_summary(org_code: str):
    row = _conn().execute(
        """SELECT COUNT(*) AS checks, COALESCE(SUM(med_count), 0) AS meds,
                  COALESCE(SUM(count_red > 0), 0) AS with_red, COALESCE(SUM(count_amber > 0), 0) AS with_amber
           FROM stat_event WHERE org_code = ?""", (org_code,),
    ).fetchone()
    return dict(row)


@app.get("/api/meta")
def meta():
    m = get_meta(_conn())
    approved = _conn().execute(
        "SELECT COUNT(*) AS total, SUM(approved_by IS NOT NULL) AS approved FROM message_template"
    ).fetchone()
    return {
        "data_date": m.get("data_date"),
        "rule_version": m.get("rule_version"),
        "dataset": m.get("dataset"),
        "templates": {"total": approved["total"], "approved": approved["approved"] or 0},
        "strict_approval": config.STRICT_APPROVAL,
        "ocr_provider": config.OCR_PROVIDER,
    }


# ---------- 빌드된 웹앱 제공 (npm run build 후) ----------

if config.FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=config.FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        target = config.FRONTEND_DIST / path
        if path and target.is_file():
            return FileResponse(target)
        return FileResponse(config.FRONTEND_DIST / "index.html")
