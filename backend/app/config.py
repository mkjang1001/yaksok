"""환경 변수 설정. 값은 backend/.env 대신 셸 환경 변수로 넣는다 (README 참고)."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

DB_PATH = Path(os.environ.get("YAKSOK_DB", BASE_DIR / "data" / "yaksok.db"))

# true: 감수 약사 승인(approved_by)이 없는 문구는 내보내지 않는다. 시범 운영 전에는 반드시 켠다.
STRICT_APPROVAL = os.environ.get("YAKSOK_STRICT_APPROVAL", "false").lower() == "true"

# 사진 인식 제공자: none | google | clova
OCR_PROVIDER = os.environ.get("YAKSOK_OCR_PROVIDER", "none").lower()
GOOGLE_VISION_API_KEY = os.environ.get("GOOGLE_VISION_API_KEY", "")
CLOVA_OCR_URL = os.environ.get("CLOVA_OCR_URL", "")
CLOVA_OCR_SECRET = os.environ.get("CLOVA_OCR_SECRET", "")

# 공공데이터포털 서비스키 (데이터 수집 스크립트용)
DATA_GO_KR_SERVICE_KEY = os.environ.get("DATA_GO_KR_SERVICE_KEY", "")

FRONTEND_DIST = BASE_DIR.parent / "frontend" / "dist"

MAX_UPLOAD_BYTES = 8 * 1024 * 1024
