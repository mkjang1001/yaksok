export type Severity = "red" | "amber" | "grey";

export interface Pill {
  shape: "round" | "oval" | "capsule" | null;
  color: string | null;
  image_url: string | null;
}

export interface Ingredient {
  code: string;
  name: string;
  name_en: string | null;
  amount: string | null;
}

export interface Drug {
  item_seq: string;
  name: string;
  company: string | null;
  is_otc: boolean;
  category: string | null;
  efficacy: string | null;
  pill: Pill;
  ingredients: Ingredient[];
  data_date: string | null;
  is_sample: boolean;
  score?: number;
}

/** 기기에만 저장되는 내 약 한 개 */
export interface Med {
  id: string;
  item_seq: string | null; // 없으면 "목록에 없는 약"
  name: string;
  category: string | null;
  pill: Pill | null;
  ingredients: string[];
  received_from: string;
  source: "ocr" | "barcode" | "search" | "manual";
  added_at: string;
}

export interface Finding {
  id: string;
  rule: string;
  severity: Severity;
  title: string;
  body: string;
  question: string | null;
  tts_text: string;
  items: string[];
  item_labels: string[];
  ingredients: string[];
  group: string | null;
  evidence: { source: string | null; detail: string | null; data_date: string | null };
  template: { rule_type: string; version: number; approved: boolean };
}

export interface CheckResult {
  findings: Finding[];
  unchecked: { index: number; item_seq: string | null; display_name: string; reason: string }[];
  med_count: number;
  counts: Record<Severity, number>;
  rule_version: string;
  data_date: string | null;
  dataset: string | null;
  strict_approval: boolean;
}

/** 검색 목록 조각에서 바로 알 수 있는 정보만 담은 약 (성분은 목록에 넣을 때 받는다) */
export type DrugSummary = Pick<Drug, "item_seq" | "name" | "category" | "company" | "pill"> & { score?: number };

export interface OcrLine {
  line: string;
  dose: string | null;
  candidates: DrugSummary[];
}

export interface Profile {
  ageBand: "65+" | "under65";
  fontScale: 0 | 1 | 2;
  contrast: boolean;
  ttsRate: 0 | 1 | 2;
}

export interface HelperSession {
  orgCode: string;
  startedAt: string;
}
