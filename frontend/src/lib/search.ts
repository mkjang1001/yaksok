/** 약 이름 검색과 봉투 글자 매칭 — backend/app/search.py, ocr.py 와 같은 점수 규칙. */
import { DrugData, searchKey, type SearchRow } from "./data";
import { bestWindowSimilarity, chosung, decompose, isChosungQuery, normalize } from "./hangul";
import type { Drug, DrugSummary, OcrLine } from "../types";

const FUZZY_THRESHOLD = 0.72;
const DOSE_RE = /(\d+(?:\.\d+)?)\s*(mg|㎎|밀리그램|mcg|㎍|g|ml|㎖)/i;
const DOSE_RE_ALL = /(\d+(?:\.\d+)?)\s*(mg|㎎|밀리그램|mcg|㎍|g|ml|㎖)/gi;
const NAME_DOSE_RE = /\d+(?:\.\d+)?\s*(mg|㎎|mcg|㎍|g|ml|㎖)/gi;
const NOISE_WORDS = ["복용", "식후", "식전", "취침", "아침", "점심", "저녁", "약국", "조제", "처방", "환자",
  "보험", "전화", "주소", "일분", "투약", "총", "원", "합계", "약제비", "보관"];
const MIN_MATCH = 0.7;

export const MIN_QUERY_CHARS = 2;

export interface SearchHit { score: number; row: SearchRow }

function scoreRows(query: string, rows: SearchRow[]): SearchHit[] {
  const q = normalize(query);
  if (!q) return [];
  const hits: SearchHit[] = [];
  if (isChosungQuery(q)) {
    for (const row of rows) {
      const cho = chosung(normalize(row[1]));
      if (cho.startsWith(q)) hits.push({ score: 0.85, row });
      else if (cho.includes(q)) hits.push({ score: 0.75, row });
    }
    return hits;
  }
  const qj = decompose(q);
  for (const row of rows) {
    const norm = normalize(row[1]);
    const stem = normalize(row[1].replace(NAME_DOSE_RE, ""));
    let s = 0;
    if (norm === q) s = 1;
    else if (norm.startsWith(q)) s = 0.95;
    else if (norm.includes(q)) s = 0.88;
    else if (stem.length >= 3 && q.includes(stem)) s = 0.9; // 긴 줄 안에 약 이름이 통째로 있음
    else if (q.length >= 2) {
      const sim = bestWindowSimilarity(qj, decompose(norm));
      s = sim >= FUZZY_THRESHOLD ? 0.5 + 0.35 * sim : 0;
    }
    if (s > 0) hits.push({ score: s, row });
  }
  return hits;
}

const byScore = (a: SearchHit, b: SearchHit) =>
  b.score - a.score || a.row[1].length - b.row[1].length || a.row[1].localeCompare(b.row[1]);

/** 검색어 앞 두 글자의 초성 조각만 받아서 찾는다. 두 글자 미만이면 찾지 않는다. */
export async function searchDrugs(data: DrugData, query: string, limit = 10): Promise<SearchHit[]> {
  const q = normalize(query);
  if ([...q].length < MIN_QUERY_CHARS) return [];
  const key = searchKey(q);
  if (!key) return [];
  const rows = await data.searchRows(key);
  return scoreRows(q, rows).sort(byScore).slice(0, limit);
}

export function rowToDrug(row: SearchRow): DrugSummary {
  return { item_seq: row[0], name: row[1], category: row[2], company: row[3],
    pill: { shape: row[4] as Drug["pill"]["shape"], color: row[5], image_url: null } };
}

export function splitDose(line: string): [string, string | null] {
  const m = line.match(DOSE_RE);
  let dose: string | null = null;
  if (m) {
    const unit = m[2].toLowerCase().replace("㎎", "mg").replace("밀리그램", "mg").replace("㎍", "mcg").replace("㎖", "ml");
    dose = `${m[1]}${unit}`;
  }
  return [line.replace(DOSE_RE_ALL, " "), dose];
}

function isNoise(norm: string): boolean {
  const hangul = [...norm].filter((ch) => ch >= "가" && ch <= "힣").length;
  if (hangul < 2) return true;
  return NOISE_WORDS.some((w) => norm.includes(w)) && norm.length > 12;
}

/** 봉투 글자 → 줄마다 약 후보 Top-3. 줄 앞 두 글자의 검색 조각만 받는다. */
export async function matchLines(data: DrugData, lines: string[], top = 3): Promise<OcrLine[]> {
  const prepared = lines
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const [text, dose] = splitDose(raw);
      return { raw, text, dose, norm: normalize(text) };
    })
    .filter((l) => !isNoise(l.norm));

  const results = await Promise.all(prepared.map(async (l): Promise<OcrLine | null> => {
    const key = searchKey(l.norm);
    if (!key) return null;
    const rows = await data.searchRows(key);
    const hits = scoreRows(l.text, rows)
      .map((h) => ({ ...h, score: Math.min(1, h.score + (l.dose && normalize(h.row[1]).includes(normalize(l.dose)) ? 0.05 : 0)) }))
      .filter((h) => h.score >= MIN_MATCH)
      .sort(byScore)
      .slice(0, top);
    if (hits.length === 0) return null;
    // 후보는 검색 목록 정보만으로 보여 주고, 상세(성분)는 사용자가 "맞아요"를 눌러 목록에 넣을 때 받는다
    return {
      line: l.raw,
      dose: l.dose,
      candidates: hits.map((h) => ({ ...rowToDrug(h.row), score: Math.round(h.score * 1000) / 1000 })),
    };
  }));
  return results.filter((r): r is OcrLine => !!r && r.candidates.length > 0);
}
