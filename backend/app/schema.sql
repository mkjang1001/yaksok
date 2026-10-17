-- 약속(藥束) 약물 DB 스키마 (설계서 B8)
-- 개인 약 목록은 여기에 저장하지 않는다. 서버 DB에는 공공데이터 기반 약물 정보와 익명 통계만 있다.

CREATE TABLE IF NOT EXISTS drug_product (
  item_seq       TEXT PRIMARY KEY,          -- 품목기준코드
  name           TEXT NOT NULL,             -- 품목명
  name_norm      TEXT NOT NULL,             -- 공백·특수문자 제거한 검색용 이름
  name_chosung   TEXT NOT NULL,             -- 초성 검색용
  company        TEXT,
  is_otc         INTEGER NOT NULL DEFAULT 0, -- 1: 일반의약품
  easy_category  TEXT,                      -- "혈압약"처럼 어르신이 아는 말
  easy_efficacy  TEXT,                      -- e약은요 효능 (쉬운 말)
  pill_shape     TEXT,                      -- round | oval | capsule
  pill_color     TEXT,                      -- 화면용 대표 색 (#rrggbb)
  pill_image_url TEXT,                      -- 낱알식별 사진 URL
  data_date      TEXT,
  is_sample      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS drug_barcode (
  barcode   TEXT PRIMARY KEY,               -- 표준코드
  item_seq  TEXT NOT NULL REFERENCES drug_product(item_seq) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ingredient (
  ingr_code TEXT PRIMARY KEY,               -- DUR 성분코드
  name_ko   TEXT NOT NULL,
  name_en   TEXT
);

CREATE TABLE IF NOT EXISTS product_ingredient (
  item_seq  TEXT NOT NULL REFERENCES drug_product(item_seq) ON DELETE CASCADE,
  ingr_code TEXT NOT NULL REFERENCES ingredient(ingr_code),
  amount    TEXT,
  PRIMARY KEY (item_seq, ingr_code)
);

-- COMBO_TABOO: ingr_a + ingr_b 병용금기
-- EFFICACY_DUP: ingr_a 가 group_code 효능군에 속함 (한 행 = 성분 1개의 소속)
-- ELDERLY: ingr_a 노인주의
CREATE TABLE IF NOT EXISTS dur_rule (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL CHECK (type IN ('COMBO_TABOO', 'EFFICACY_DUP', 'ELDERLY')),
  ingr_a     TEXT NOT NULL REFERENCES ingredient(ingr_code),
  ingr_b     TEXT REFERENCES ingredient(ingr_code),
  group_code TEXT,
  group_name TEXT,
  detail     TEXT,                          -- 원문 사유
  source     TEXT,
  data_date  TEXT,
  is_sample  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dur_type_a ON dur_rule(type, ingr_a);
CREATE INDEX IF NOT EXISTS idx_dur_type_b ON dur_rule(type, ingr_b);

-- 감수 약사가 승인한 문구 (설계서 B6)
CREATE TABLE IF NOT EXISTS message_template (
  rule_type   TEXT PRIMARY KEY,             -- R1, R2, R3, R3_SAME, R4, R5, R5_PROGRAM
  severity    TEXT NOT NULL CHECK (severity IN ('red', 'amber', 'grey')),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  question    TEXT,
  tts_text    TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  version     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 도우미 모드 종료 시 들어오는 익명 통계. 개인을 알아볼 수 있는 값은 받지 않는다.
CREATE TABLE IF NOT EXISTS stat_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  org_code    TEXT NOT NULL,
  event_date  TEXT NOT NULL,
  med_count   INTEGER NOT NULL,
  count_red   INTEGER NOT NULL,
  count_amber INTEGER NOT NULL,
  count_grey  INTEGER NOT NULL,
  rule_types  TEXT NOT NULL,                -- 쉼표로 구분 (R1,R2 ...)
  created_at  TEXT NOT NULL
);
