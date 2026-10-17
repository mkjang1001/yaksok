/**
 * 브라우저 점검 엔진 테스트 — backend/tests/test_rules.py, test_search_ocr.py 와 같은 기대값.
 * public/data 의 샘플 조각 파일을 그대로 읽는다 (먼저 `python -m app.export_static` 실행).
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DrugData, bucket, fnv1a, searchKey } from "./data";
import { chosung, josa, normalize } from "./hangul";
import { checkMeds, type CheckItem } from "./rules";
import { matchLines, searchDrugs, splitDose } from "./search";

const DATA_DIR = join(__dirname, "..", "..", "public", "data");

function makeData(log?: string[]) {
  return new DrugData(async (path) => {
    log?.push(path);
    const file = join(DATA_DIR, path);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : null;
  });
}

const DEMO: CheckItem[] = [
  { item_seq: "S000000001", received_from: "OO내과" },
  { item_seq: "S000000002", received_from: "OO내과" },
  { item_seq: "S000000003", received_from: "OO내과" },
  { item_seq: "S000000005", received_from: "OO내과" },
  { item_seq: "S000000010", received_from: "정형외과" },
  { item_seq: "S000000011", received_from: "정형외과" },
  { item_seq: "S000000008", received_from: "정형외과" },
  { item_seq: "S000000101", received_from: "약국에서 산 약" },
  { item_seq: null, display_name: "파스(이름 모름)" },
];
const rulesOf = (r: { findings: { rule: string }[] }) => r.findings.map((f) => f.rule);

describe("조각 나누기", () => {
  it("파이썬과 같은 해시", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(bucket("ab", 256)).toHaveLength(2);
    expect(bucket("ab", 64)).toHaveLength(2);
  });
  it("검색 키", () => {
    expect(searchKey("에소메프라졸정20mg")).toBe("3147-3145");
    expect(searchKey("에")).toBeNull();
  });
});

describe("한글", () => {
  it("조사", () => {
    expect(josa("진통제", "과", "와")).toBe("진통제와");
    expect(josa("위장약", "과", "와")).toBe("위장약과");
    expect(josa("20mg", "은", "는")).toBe("20mg은");
    expect(josa("5ml", "으로", "로")).toBe("5ml로");
    expect(josa("ABC", "은", "는")).toBe("ABC는");
  });
  it("정규화·초성", () => {
    expect(normalize("에소메프라졸정 20 mg!")).toBe("에소메프라졸정20mg");
    expect(chosung("에소메")).toBe("ㅇㅅㅁ");
  });
});

describe("점검 엔진", () => {
  it("목업 예시", async () => {
    const r = await checkMeds(makeData(), "65+", DEMO);
    expect(rulesOf(r)).toEqual(["R2", "R3", "R4", "R5"]);
    expect(r.counts).toEqual({ red: 1, amber: 2, grey: 1 });
    expect(r.med_count).toBe(9);
    expect(r.unchecked.map((u) => u.display_name)).toEqual(["파스(이름 모름)"]);
    expect(r.findings[0].body).toBe(
      "정형외과 진통제와 약국에서 산 종합감기약에 모두 아세트아미노펜이 들어 있어요. 함께 드셔도 되는지 약사님께 여쭤보세요.");
    expect(r.findings[1].group).toBe("위산 억제제");
    expect(r.findings[2].ingredients).toEqual(["클로르페니라민"]);
    expect(r.dataset).toBe("sample");
  });

  it("등록한 약의 조각만 받는다", async () => {
    const log: string[] = [];
    await checkMeds(makeData(log), "65+", [{ item_seq: "S000000012" }, { item_seq: "S000000004" }]);
    expect(log.some((p) => p.startsWith("search/"))).toBe(false);
    expect(log.filter((p) => p.startsWith("drug/")).length).toBeLessThanOrEqual(2);
    expect(log.filter((p) => p.startsWith("rule/")).length).toBeLessThanOrEqual(2);
  });

  it("병용금기", async () => {
    const r = await checkMeds(makeData(), "65+", [
      { item_seq: "S000000012", received_from: "피부과" }, { item_seq: "S000000004", received_from: "OO내과" }]);
    expect(rulesOf(r)).toEqual(["R1"]);
    expect(r.findings[0].ingredients).toEqual(["이트라코나졸", "심바스타틴"]);
  });

  it("같은 곳 효능군 중복은 참고", async () => {
    const r = await checkMeds(makeData(), "under65", [
      { item_seq: "S000000005", received_from: "OO내과" }, { item_seq: "S000000008", received_from: "OO내과" }]);
    expect(rulesOf(r)).toEqual(["R3_SAME"]);
    expect(r.findings[0].body).toContain("에소메프라졸정 20mg과 라베프라졸정 10mg은");
  });

  it("받은 곳 모르면 물어보기", async () => {
    const r = await checkMeds(makeData(), "under65", [{ item_seq: "S000000011" }, { item_seq: "S000000103" }]);
    expect(rulesOf(r)).toEqual(["R3"]);
  });

  it("같은 성분은 효능군 중복으로 또 알리지 않음", async () => {
    const r = await checkMeds(makeData(), "under65", [
      { item_seq: "S000000005", received_from: "OO내과" }, { item_seq: "S000000007", received_from: "정형외과" }]);
    expect(rulesOf(r)).toEqual(["R2"]);
  });

  it("노인주의는 65세 이상만", async () => {
    const items = [{ item_seq: "S000000014", received_from: "정신건강의학과" }];
    expect(rulesOf(await checkMeds(makeData(), "65+", items))).toEqual(["R4"]);
    expect(rulesOf(await checkMeds(makeData(), "under65", items))).toEqual([]);
  });

  it("같은 약은 한 번만", async () => {
    const r = await checkMeds(makeData(), "under65", [{ item_seq: "S000000001" }, { item_seq: "S000000001" }]);
    expect(r.med_count).toBe(1);
  });

  it("다제약물 기준", async () => {
    const four = Array.from({ length: 4 }, (_, i) => ({ item_seq: null, display_name: `약${i}` }));
    expect(rulesOf(await checkMeds(makeData(), "65+", four))).toEqual([]);
    const ten = Array.from({ length: 10 }, (_, i) => ({ item_seq: null, display_name: `약${i}` }));
    const r = await checkMeds(makeData(), "65+", ten);
    expect(rulesOf(r)).toEqual(["R5_PROGRAM"]);
    expect(r.findings[0].title).toBe("약을 10개 드시고 계세요");
  });

  it("엄격 모드는 감수 전 문구를 숨김", async () => {
    const r = await checkMeds(makeData(), "65+", DEMO, { strictApproval: true });
    expect(r.findings.every((f) => f.title === "확인이 필요한 항목이 있어요")).toBe(true);
  });
});

describe("검색과 봉투 글자", () => {
  it("앞부분·초성·오타", async () => {
    const d = makeData();
    expect((await searchDrugs(d, "에소메"))[0].row[1]).toMatch(/^에소메프라졸/);
    expect((await searchDrugs(d, "ㅇㅅㅁ")).map((h) => h.row[0])).toContain("S000000005");
    expect((await searchDrugs(d, "에소메프라줄"))[0].row[1]).toMatch(/^에소메프라졸/);
    expect(await searchDrugs(d, "가나다라마바")).toEqual([]);
    expect(await searchDrugs(d, "에")).toEqual([]);
  });

  it("검색은 그 초성 조각 하나만 받는다", async () => {
    const log: string[] = [];
    await searchDrugs(makeData(log), "에소메");
    expect(log).toEqual(["search/3147-3145.json"]);
  });

  it("함량 분리", () => {
    expect(splitDose("라베프라졸정 10밀리그램")[1]).toBe("10mg");
    expect(splitDose("암로디핀정5㎎")[1]).toBe("5mg");
  });

  it("함량이 맞는 후보를 먼저, 잡음 줄은 건너뜀", async () => {
    const out = await matchLines(makeData(), [
      "OO약국 조제일자 2026.10.10",
      "에소메프라졸정 40mg 1일 1회",
      "아침 식후 30분 복용하세요 총 30일분",
      "라베프라졸정 10밀리그램",
    ]);
    expect(out.map((l) => l.candidates[0].item_seq)).toEqual(["S000000006", "S000000008"]);
  });

  it("봉투 후보를 보여 줄 때는 품목 상세를 받지 않는다", async () => {
    const log: string[] = [];
    await matchLines(makeData(log), ["에소메프라졸정 40mg", "라베프라졸정 10mg"]);
    expect(log.every((p) => p.startsWith("search/"))).toBe(true);
  });
});
