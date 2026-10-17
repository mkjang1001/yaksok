/**
 * 점검 엔진 (설계서 B5) — 브라우저 안에서 돈다. 등록한 약의 품목·성분 규칙 조각만 받아서 계산한다.
 * backend/app/rules.py 와 같은 규칙이며, 테스트(rules.test.ts)로 결과가 같은지 확인한다.
 *
 * R1 병용금기 · R2 같은 성분 중복 · R3 효능군 중복 · R4 노인주의 · R5 다제약물
 */
import type { DrugData, RuleEvidence, Template } from "./data";
import { josa } from "./hangul";
import type { CheckResult, Drug, Finding, Severity } from "../types";

const SEVERITY_ORDER: Record<Severity, number> = { red: 0, amber: 1, grey: 2 };
const POLYPHARMACY_MIN = 5;
const PROGRAM_MIN = 10;
const PHARMACY_PLACES = ["약국", "약국 구매", "약국에서 산 약", "약국에서 삼"];
const FALLBACK = {
  title: "확인이 필요한 항목이 있어요",
  body: "이 목록을 약사·의사에게 보여 주고 함께 확인하세요.",
  question: null,
  tts_text: "확인이 필요한 항목이 있어요. 약사님께 목록을 보여 주세요.",
};

export interface CheckItem { item_seq: string | null; display_name?: string; received_from?: string }

interface Med { index: number; itemSeq: string; place: string; product: Drug; label: string }

function labelOf(p: Drug, place: string): string {
  const category = p.category ?? p.name;
  if (!place) return category;
  if (PHARMACY_PLACES.includes(place) || place.includes("약국에서")) return `약국에서 산 ${category}`;
  return `${place} ${category}`;
}

function pairLabels(meds: Med[]): [string, string] {
  let [la, lb] = [meds[0].label, meds[1].label];
  if (la === lb) [la, lb] = [meds[0].product.name, meds[1].product.name];
  if (meds.length > 2) lb = `${lb} 등 ${meds.length - 1}개 약`;
  return [la, lb];
}

function vars(o: { a?: string; b?: string; ingredient?: string; group?: string; count?: number }) {
  const v: Record<string, string> = { a: o.a ?? "", b: o.b ?? "", ingredient: o.ingredient ?? "",
    group: o.group ?? "", count: String(o.count ?? 0) };
  if (o.a) Object.assign(v, { a_wa: josa(o.a, "과", "와"), a_eun: josa(o.a, "은", "는") });
  if (o.b) Object.assign(v, { b_eun: josa(o.b, "은", "는"), b_eul: josa(o.b, "을", "를") });
  if (o.ingredient) Object.assign(v, { ingredient_i: josa(o.ingredient, "이", "가"), ingredient_eun: josa(o.ingredient, "은", "는") });
  return v;
}

const render = (s: string | null, v: Record<string, string>) =>
  s === null ? null : s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");

export interface CheckOptions { strictApproval?: boolean }

export async function checkMeds(data: DrugData, ageBand: "65+" | "under65", items: CheckItem[],
  opts: CheckOptions = {}): Promise<CheckResult> {
  const strict = opts.strictApproval ?? false;
  const seqs = [...new Set(items.map((i) => i.item_seq).filter((s): s is string => !!s))];
  const [meta, templates, products] = await Promise.all([data.meta(), data.templates(), data.drugs(seqs)]);

  const meds: Med[] = [];
  const unchecked: CheckResult["unchecked"] = [];
  const seen = new Set<string>();
  items.forEach((it, index) => {
    const seq = it.item_seq;
    const place = (it.received_from ?? "").trim();
    if (seq && products[seq]) {
      if (seen.has(seq)) return;
      seen.add(seq);
      meds.push({ index, itemSeq: seq, place, product: products[seq], label: labelOf(products[seq], place) });
    } else {
      unchecked.push({ index, item_seq: seq, display_name: it.display_name || seq || "이름 모르는 약",
        reason: seq ? "not_in_db" : "no_code" });
    }
  });

  const finding = (ruleType: string, ms: Med[], v: Record<string, string>, evidence: RuleEvidence,
    ingredients: string[] = [], group: string | null = null): Finding => {
    const t: Template = templates[ruleType];
    const approved = !!t.approved_by;
    const text = approved || !strict ? t : { ...t, ...FALLBACK };
    return {
      id: `${ruleType}:${ms.map((m) => m.itemSeq).join("+")}${group ? `:${group}` : ""}`,
      rule: ruleType,
      severity: t.severity,
      title: render(text.title, v)!,
      body: render(text.body, v)!,
      question: render(text.question, v),
      tts_text: render(text.tts_text, v)!,
      items: ms.map((m) => m.itemSeq),
      item_labels: ms.map((m) => m.label),
      ingredients,
      group,
      evidence: { source: evidence.source, detail: evidence.detail, data_date: evidence.data_date },
      template: { rule_type: ruleType, version: t.version, approved },
    };
  };

  const findings: Finding[] = [];
  const byIngr = new Map<string, Med[]>();
  const ingrName = new Map<string, string>();
  for (const m of meds) {
    for (const ing of m.product.ingredients) {
      byIngr.set(ing.code, [...(byIngr.get(ing.code) ?? []), m]);
      ingrName.set(ing.code, ing.name);
    }
  }
  const codes = [...byIngr.keys()];
  const rules = codes.length ? await data.rules(codes) : {};

  // R1 병용금기
  const donePairs = new Set<string>();
  for (const a of codes) {
    for (const c of rules[a]?.combo ?? []) {
      if (!byIngr.has(c.with)) continue;
      for (const ma of byIngr.get(a)!) {
        for (const mb of byIngr.get(c.with)!) {
          const key = [ma.itemSeq, mb.itemSeq].sort().join("|");
          if (ma === mb || donePairs.has(key)) continue;
          donePairs.add(key);
          const [la, lb] = pairLabels([ma, mb]);
          findings.push(finding("R1", [ma, mb], vars({ a: la, b: lb }), c, [ingrName.get(a)!, ingrName.get(c.with)!]));
        }
      }
    }
  }

  // R2 같은 성분 중복
  for (const [code, ms] of byIngr) {
    if (ms.length < 2) continue;
    const [la, lb] = pairLabels(ms);
    const name = ingrName.get(code)!;
    const dates = ms.map((m) => m.product.data_date ?? "").sort();
    findings.push(finding("R2", ms, vars({ a: la, b: lb, ingredient: name }),
      { source: "품목-성분 정보", detail: `${name} 성분이 ${ms.length}개 약에 들어 있음`, data_date: dates[dates.length - 1] || null },
      [name]));
  }

  // R3 효능군 중복 — 받은 곳이 모두 같으면 '참고'로 낮춘다
  const groups = new Map<string, { name: string; ev: RuleEvidence; meds: Map<string, Med>; codes: Set<string> }>();
  for (const code of codes) {
    for (const g of rules[code]?.groups ?? []) {
      const entry = groups.get(g.code) ?? { name: g.name, ev: g, meds: new Map(), codes: new Set<string>() };
      for (const m of byIngr.get(code)!) entry.meds.set(m.itemSeq, m);
      entry.codes.add(code);
      groups.set(g.code, entry);
    }
  }
  for (const g of groups.values()) {
    const ms = [...g.meds.values()];
    if (ms.length < 2 || g.codes.size < 2) continue; // 성분이 하나뿐이면 R2가 다룬다
    const places = new Set(ms.map((m) => m.place));
    const samePlace = places.size === 1 && !places.has("");
    const [la, lb] = pairLabels(ms);
    findings.push(finding(samePlace ? "R3_SAME" : "R3", ms, vars({ a: la, b: lb, group: g.name }), g.ev,
      [...g.codes].map((c) => ingrName.get(c)!).sort((x, y) => x.localeCompare(y, "ko")), g.name));
  }

  // R4 노인주의
  if (ageBand === "65+") {
    for (const code of codes) {
      const ev = rules[code]?.elderly;
      if (!ev) continue;
      const name = ingrName.get(code)!;
      for (const m of byIngr.get(code)!) findings.push(finding("R4", [m], vars({ a: m.label, ingredient: name }), ev, [name]));
    }
  }

  // R5 다제약물 (점검하지 못한 약도 개수에 넣는다)
  const count = meds.length + unchecked.length;
  if (count >= POLYPHARMACY_MIN) {
    findings.push(finding(count >= PROGRAM_MIN ? "R5_PROGRAM" : "R5", [], vars({ count }),
      { source: "약 개수", detail: `${count}개 (기준 ${POLYPHARMACY_MIN}개 이상)`, data_date: null }));
  }

  findings.sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]);
  const counts = { red: 0, amber: 0, grey: 0 } as Record<Severity, number>;
  for (const f of findings) counts[f.severity]++;
  return {
    findings, unchecked, med_count: count, counts,
    rule_version: meta.rule_version, data_date: meta.data_date, dataset: meta.dataset, strict_approval: strict,
  };
}
