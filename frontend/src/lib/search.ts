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

/**
 * 이 글자(정규화된 이름·검색어)로 받을 검색 조각.
 * 보통은 앞 두 글자 초성 조각 하나. 그 키가 커서 나뉘었으면(meta.split_search_keys)
 * 세 글자 초성 조각 + 두 글자 파일(세 글자 키를 못 만드는 짧은 이름)을 받고,
 * 두 글자뿐이면 두 글자 파일만 받고 needMore 로 "한 글자 더" 안내를 하게 한다.
 */
export async function searchKeysFor(data: DrugData, norm: string): Promise<{ keys: string[]; needMore: boolean }> {
  const key = searchKey(norm);
  if (!key) return { keys: [], needMore: false };
  const m = await data.meta();
  if (!m.split_search_keys?.includes(key)) return { keys: [key], needMore: false };
  const sub = searchKey(norm, 3);
  if (!sub) return { keys: [key], needMore: true };
  const children = m.search_children?.[key];
  // 세 글자 키 조각이 없으면 그 글자로 시작하는 약이 없는 것: 받지 않는다
  return { keys: !children || children.includes(sub) ? [sub, key] : [key], needMore: false };
}

async function rowsFor(data: DrugData, keys: string[]): Promise<SearchRow[]> {
  return (await Promise.all(keys.map((k) => data.searchRows(k)))).flat();
}

export interface SearchOutcome { hits: SearchHit[]; needMore: boolean }

/** 검색어 앞 두(나뉜 키면 세) 글자의 초성 조각만 받아서 찾는다. 두 글자 미만이면 찾지 않는다. */
export async function searchDrugsOutcome(data: DrugData, query: string, limit = 10): Promise<SearchOutcome> {
  const q = normalize(query);
  if ([...q].length < MIN_QUERY_CHARS) return { hits: [], needMore: false };
  const { keys, needMore } = await searchKeysFor(data, q);
  const rows = await rowsFor(data, keys);
  return { hits: scoreRows(q, rows).sort(byScore).slice(0, limit), needMore };
}

export async function searchDrugs(data: DrugData, query: string, limit = 10): Promise<SearchHit[]> {
  return (await searchDrugsOutcome(data, query, limit)).hits;
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

/** 처방전 약 줄 앞의 9자리 보험(EDI) 코드. 전화·사업자번호처럼 -로 이어진 숫자는 빼고 찾는다. */
const INSURANCE_RE = /(?<![\d-])(\d{9})(?![\d-])/;

/** 줄 전체를 버리는 잡음: 약국명·전화·주소·날짜·금액 */
const NOISE_LINE_RES: RegExp[] = [
  /약국|약사|조제|처방(전|일|의|기관)|교부|발행|병원|의원|클리닉|환자|성명|주민|면허/, // 약국·병원·사람
  /전화|tel|fax|팩스|☎|\d{2,4}[-)\s.]\s*\d{3,4}[-.\s]\d{4}/i, // 전화
  /주소|(특별|광역|자치)?[가-힣]{1,4}(시|도)\s+[가-힣]{1,5}(구|군|시)|[가-힣\d]+(로|길)\s*\d+(-\d+)?(번길)?/, // 주소
  /(19|20)\d{2}\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}|(조제|처방|교부)?일자|\d{1,2}\s*월\s*\d{1,2}\s*일/, // 날짜
  /\d{1,3}(,\d{3})+\s*원?|\d+\s*원(?![가-힣])|금액|본인\s*부담|약제비|합계|수납|영수|카드|현금|비급여|급여/, // 금액
  /사업자|등록번호|요양기관|기관\s*기호/,
];

/** 약 이름 옆에 붙어 있는 복용법 조각 (지우고 나서 남은 글자로 판단) */
const INSTRUCTION_RES: RegExp[] = [
  /(1일|하루)\s*\d+\s*(회|번)/g,
  /\d+\s*회\s*\d+(\.\d+)?\s*(정|캡슐|포|알|봉|매|ml)/g,
  /\d+(\.\d+)?\s*(정|캡슐|포|알|봉)\s*씩/g,
  /\d+\s*일\s*(분|치)/g,
  /(아침|점심|저녁|잠자기|자기|취침)\s*(전|후)?/g,
  /식\s*(전|후|간)/g,
  /공복|매일|필요\s*시|아플\s*때/g,
  /복용\s*(하세요|하십시오|합니다|방법)?|드세요|드십시오|드시고|하세요/g,
  /\d+\s*분\s*(이내|후|전)?/g,
  /(?<![가-힣])총(?![가-힣])/g,
];
const stripInstructions = (text: string) => INSTRUCTION_RES.reduce((t, re) => t.replace(re, " "), text);

const LEADING_JUNK = /^[\s\d.)\]\-–·•*#:①-⑳]+/;
const TRAILING_NUMBERS = /(\s+\d+(\.\d+)?)+\s*$/;
const FORM_END = /(정|캡슐|캅셀|시럽|현탁액|과립|산|연고|크림|겔|패취|패치|액|주)$/;

export function extractInsuranceCode(line: string): string | null {
  return line.match(INSURANCE_RE)?.[1] ?? null;
}

function hangulCount(text: string): number {
  return [...text].filter((ch) => ch >= "가" && ch <= "힣").length;
}

/** 약국명·전화·주소·날짜·금액 줄인지 (함량과 보험 코드는 빼고 본다: "…로 20mg" 같은 이름이 주소로 잡히지 않게) */
export function isNoiseLine(raw: string): boolean {
  const code = extractInsuranceCode(raw);
  const [noDose] = splitDose(code ? raw.replace(code, " ") : raw);
  return NOISE_LINE_RES.some((re) => re.test(noDose));
}

function isNoise(norm: string): boolean {
  if (hangulCount(norm) < 2) return true;
  return NOISE_WORDS.some((w) => norm.includes(w)) && norm.length > 12;
}

/**
 * 한 줄에 약이 둘 이상 붙어 있으면 나눈다.
 * - 함량 뒤에 바로 다른 이름이 오면 ("에소메프라졸정40mg 라베프라졸정10mg")
 * - 쉼표·빗금·가운뎃점으로 이어져 있으면 ("타이레놀정, 아스피린정")
 * - 제형으로 끝나는 이름 두 개가 띄어 쓰여 있으면 ("암로디핀정 메트포르민정")
 */
export function splitDrugs(line: string): string[] {
  const marked = line
    .replace(/(\d+(?:\.\d+)?\s*(?:mg|㎎|밀리그램|mcg|㎍|g|ml|㎖))\s*[,/·|+]?\s*(?=[가-힣a-zA-Z[(])/gi, "$1\n")
    .replace(/([가-힣a-zA-Z\d)\]])\s*[,/·|+]\s*(?=[가-힣a-zA-Z[(])/g, "$1\n");
  return marked.split("\n").flatMap((piece) => {
    const words = piece.trim().split(/\s+/);
    if (words.length < 2) return [piece];
    const out: string[] = [];
    let cur: string[] = [];
    for (const w of words) {
      const prev = cur[cur.length - 1];
      if (prev && hangulCount(prev) >= 3 && FORM_END.test(prev) && hangulCount(w) >= 3 && FORM_END.test(w.replace(/[\d.]+\s*\w*$/, ""))) {
        out.push(cur.join(" "));
        cur = [];
      }
      cur.push(w);
    }
    out.push(cur.join(" "));
    return out;
  }).map((p) => p.trim()).filter(Boolean);
}

/** 봉투 한 줄(조각)을 약 이름·함량·보험 코드로 나눈다. 잡음이면 noise=true. */
export function prepareLine(raw: string) {
  const insurance_code = extractInsuranceCode(raw);
  const noCode = insurance_code ? raw.replace(insurance_code, " ") : raw;
  const [noDose, dose] = splitDose(noCode);
  const text = stripInstructions(noDose)
    .replace(TRAILING_NUMBERS, " ")
    .replace(LEADING_JUNK, "")
    .replace(/\s+/g, " ")
    .trim();
  const norm = normalize(text);
  return { raw, text, dose, norm, insurance_code, noise: isNoiseLine(raw) || isNoise(norm) };
}

/** 봉투·처방전 글자에서 보험 코드만 모은다 (코드→품목 조회는 데이터 쪽에서 붙인다). */
export function extractInsuranceCodes(lines: string[]): string[] {
  const codes = lines.flatMap(splitDrugs).map(extractInsuranceCode).filter((c): c is string => !!c);
  return [...new Set(codes)];
}

/** 봉투에서 찾은 한 줄 + 처방전이면 그 줄의 9자리 보험 코드 */
export interface EnvelopeLine extends OcrLine {
  insurance_code: string | null;
}

/**
 * 봉투 글자 → 줄마다 약 후보 Top-3. 줄 앞 두(나뉜 키면 세) 글자의 검색 조각만 받는다.
 * 처방전 줄에 보험코드가 있고 보험코드 조각에서 품목을 찾으면 그 약을 확실한 후보(점수 1)로 맨 앞에 둔다.
 */
export async function matchLines(data: DrugData, lines: string[], top = 3): Promise<EnvelopeLine[]> {
  const prepared = lines
    .flatMap((raw) => raw.split(/\r?\n/))
    .map((raw) => raw.trim())
    .filter((raw) => raw && !isNoiseLine(raw))
    .flatMap(splitDrugs)
    .map(prepareLine)
    .filter((l) => !l.noise);

  const results = await Promise.all(prepared.map(async (l): Promise<EnvelopeLine | null> => {
    const [{ keys }, codeSeq] = await Promise.all([
      searchKeysFor(data, l.norm),
      l.insurance_code ? data.insuranceSeq(l.insurance_code) : Promise.resolve(null),
    ]);
    const rows = await rowsFor(data, keys);
    let hits = scoreRows(l.text, rows)
      .map((h) => ({ ...h, score: Math.min(1, h.score + (l.dose && normalize(h.row[1]).includes(normalize(l.dose)) ? 0.05 : 0)) }))
      .filter((h) => h.score >= MIN_MATCH)
      .sort(byScore);
    if (codeSeq) {
      // 보험코드로 찾은 약: 이름 후보에 있으면 그 줄을 쓰고, 없을 때만 품목 상세를 받아 후보 줄을 만든다
      let row = hits.find((h) => h.row[0] === codeSeq)?.row ?? null;
      if (!row) {
        const d = await data.drug(codeSeq);
        if (d) row = [d.item_seq, d.name, d.category, d.company, d.pill.shape, d.pill.color];
      }
      if (row) hits = [{ score: 1, row }, ...hits.filter((h) => h.row[0] !== codeSeq)];
    }
    hits = hits.slice(0, top);
    if (hits.length === 0) return null;
    // 후보는 검색 목록 정보만으로 보여 주고 (보험코드로만 찾은 약은 예외), 상세(성분)는 사용자가 "맞아요"를 눌러 목록에 넣을 때 받는다
    return {
      line: l.raw,
      dose: l.dose,
      insurance_code: l.insurance_code,
      candidates: hits.map((h) => ({ ...rowToDrug(h.row), score: Math.round(h.score * 1000) / 1000 })),
    };
  }));
  return results.filter((r): r is EnvelopeLine => !!r && r.candidates.length > 0);
}
