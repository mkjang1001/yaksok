/**
 * 정적 약물 데이터 읽기. 전체 DB를 받지 않고, 필요한 조각 파일만 받아서 메모리에 둔다.
 * 조각 나누는 방식은 backend/app/export_static.py 와 같아야 한다.
 */
import { chosung } from "./hangul";
import type { Drug } from "../types";

export interface Meta {
  data_date: string | null;
  rule_version: string;
  dataset: string | null;
  /** insurance 는 보험코드 조각이 생긴 뒤의 데이터에만 있다 */
  shards: { drug: number; barcode: number; rule: number; insurance?: number; search_key_chars: number };
  /** 너무 커서 세 글자 초성 조각으로 나뉜 두 글자 키. 두 글자 파일에는 짧은 이름만 남는다. */
  split_search_keys?: string[];
  /** 나뉜 두 글자 키 → 세 글자 키 목록 */
  search_children?: Record<string, string[]>;
}

export interface RuleEvidence { detail: string | null; source: string | null; data_date: string | null }
export interface IngredientRule {
  combo: ({ with: string } & RuleEvidence)[];
  groups: ({ code: string; name: string } & RuleEvidence)[];
  elderly: RuleEvidence | null;
}
export interface Template {
  rule_type: string;
  severity: "red" | "amber" | "grey";
  title: string;
  body: string;
  question: string | null;
  tts_text: string;
  approved_by: string | null;
  approved_at: string | null;
  version: number;
}
/** 검색 조각 한 줄: [품목코드, 이름, 쉬운 분류, 제조사, 모양, 색] */
export type SearchRow = [string, string, string | null, string | null, string | null, string | null];

export class DataError extends Error {}

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(text)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function bucket(text: string, shards: number): string {
  const width = (shards - 1).toString(16).length;
  return (fnv1a(text) % shards).toString(16).padStart(width, "0");
}

export function searchKey(nameNorm: string, chars = 2): string | null {
  const head = chosung([...nameNorm].slice(0, chars).join(""));
  if ([...head].length < chars) return null;
  return [...head].map((ch) => ch.codePointAt(0)!.toString(16)).join("-");
}

/** 조각 파일을 받아 오는 방법. 테스트에서는 파일 시스템에서 읽는 함수로 바꾼다. */
export type Loader = (path: string) => Promise<unknown | null>;

const httpLoader: Loader = async (path) => {
  const base = (import.meta.env?.BASE_URL ?? "/") + "data/";
  let res: Response;
  try {
    res = await fetch(base + path);
  } catch {
    throw new DataError("약 정보를 받지 못했어요. 인터넷 연결을 확인해 주세요.");
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new DataError("약 정보를 받지 못했어요. 잠시 뒤 다시 해 주세요.");
  return res.json();
};

export class DrugData {
  private cache = new Map<string, Promise<unknown | null>>();
  private metaPromise: Promise<Meta> | null = null;

  constructor(private load: Loader = httpLoader) {}

  private get<T>(path: string): Promise<T | null> {
    let p = this.cache.get(path);
    if (!p) {
      p = this.load(path).catch((e) => {
        this.cache.delete(path); // 실패한 요청은 다음에 다시 시도
        throw e;
      });
      this.cache.set(path, p);
    }
    return p as Promise<T | null>;
  }

  meta(): Promise<Meta> {
    if (!this.metaPromise) {
      this.metaPromise = this.get<Meta>("meta.json").then((m) => {
        if (!m) throw new DataError("약 정보 목록이 없어요. 관리자에게 알려 주세요.");
        return m;
      });
      this.metaPromise.catch(() => { this.metaPromise = null; });
    }
    return this.metaPromise;
  }

  async templates(): Promise<Record<string, Template>> {
    const list = (await this.get<Template[]>("templates.json")) ?? [];
    return Object.fromEntries(list.map((t) => [t.rule_type, t]));
  }

  async searchRows(key: string): Promise<SearchRow[]> {
    return (await this.get<SearchRow[]>(`search/${key}.json`)) ?? [];
  }

  async drugs(itemSeqs: string[]): Promise<Record<string, Drug>> {
    const m = await this.meta();
    const keys = [...new Set(itemSeqs.map((s) => bucket(s, m.shards.drug)))];
    const shards = await Promise.all(keys.map((k) => this.get<Record<string, Drug>>(`drug/${k}.json`)));
    const all = Object.assign({}, ...shards.map((s) => s ?? {})) as Record<string, Drug>;
    return Object.fromEntries(itemSeqs.filter((s) => all[s]).map((s) => [s, all[s]]));
  }

  async drug(itemSeq: string): Promise<Drug | null> {
    return (await this.drugs([itemSeq]))[itemSeq] ?? null;
  }

  async barcode(code: string): Promise<Drug | null> {
    const m = await this.meta();
    const shard = await this.get<Record<string, string>>(`barcode/${bucket(code, m.shards.barcode)}.json`);
    const seq = shard?.[code];
    return seq ? this.drug(seq) : null;
  }

  /** 처방전의 9자리 보험(EDI) 코드 → 품목코드. 보험코드 조각이 없는 예전 데이터면 null. */
  async insuranceSeq(code: string): Promise<string | null> {
    const m = await this.meta();
    if (!m.shards.insurance) return null;
    const shard = await this.get<Record<string, string>>(`insurance/${bucket(code, m.shards.insurance)}.json`);
    return shard?.[code] ?? null;
  }

  async insurance(code: string): Promise<Drug | null> {
    const seq = await this.insuranceSeq(code);
    return seq ? this.drug(seq) : null;
  }

  async rules(ingrCodes: string[]): Promise<Record<string, IngredientRule>> {
    const m = await this.meta();
    const keys = [...new Set(ingrCodes.map((c) => bucket(c, m.shards.rule)))];
    const shards = await Promise.all(keys.map((k) => this.get<Record<string, IngredientRule>>(`rule/${k}.json`)));
    const all = Object.assign({}, ...shards.map((s) => s ?? {})) as Record<string, IngredientRule>;
    return Object.fromEntries(ingrCodes.filter((c) => all[c]).map((c) => [c, all[c]]));
  }
}

export const drugData = new DrugData();
