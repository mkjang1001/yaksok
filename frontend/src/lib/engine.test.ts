/**
 * 브라우저 점검 엔진 테스트 — backend/tests/test_rules.py, test_search_ocr.py 와 같은 기대값.
 * 샘플 조각 픽스처(__fixtures__)를 읽는다 — public/data 는 실제 데이터로 바뀌므로 쓰지 않는다.
 *   sample        샘플 DB 내보내기
 *   sample-split  검색 조각을 억지로 세 글자 키로 나눈 내보내기 (실제 데이터처럼 큰 키가 나뉜 경우)
 * 다시 만들기: backend 에서 `python -m app.export_fixture`
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DrugData, bucket, fnv1a, searchKey, type Loader, type Meta } from "./data";
import { chosung, josa, normalize } from "./hangul";
import { checkMeds, type CheckItem } from "./rules";
import {
  extractInsuranceCode, extractInsuranceCodes, isNoiseLine, matchLines, prepareLine, searchDrugs, searchDrugsOutcome,
  splitDose, splitDrugs,
} from "./search";

const FIXTURE_DIR = join(__dirname, "__fixtures__");
const DATASETS = ["sample", "sample-split"] as const;
type Dataset = (typeof DATASETS)[number];

/** 픽스처 파일 로더. 없는 파일은 null (빈 해시 조각은 픽스처에서 지워 두었다). */
function fileLoader(ds: Dataset, log?: string[]): Loader {
  return async (path) => {
    log?.push(path);
    const file = join(FIXTURE_DIR, ds, path);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : null;
  };
}

function makeData(ds: Dataset, log?: string[]) {
  return new DrugData(fileLoader(ds, log));
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

describe.each(DATASETS)("점검 엔진 (%s)", (ds) => {
  it("목업 예시", async () => {
    const r = await checkMeds(makeData(ds), "65+", DEMO);
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
    await checkMeds(makeData(ds, log), "65+", [{ item_seq: "S000000012" }, { item_seq: "S000000004" }]);
    expect(log.some((p) => p.startsWith("search/"))).toBe(false);
    expect(log.filter((p) => p.startsWith("drug/")).length).toBeLessThanOrEqual(2);
    expect(log.filter((p) => p.startsWith("rule/")).length).toBeLessThanOrEqual(2);
  });

  it("병용금기", async () => {
    const r = await checkMeds(makeData(ds), "65+", [
      { item_seq: "S000000012", received_from: "피부과" }, { item_seq: "S000000004", received_from: "OO내과" }]);
    expect(rulesOf(r)).toEqual(["R1"]);
    expect(r.findings[0].ingredients).toEqual(["이트라코나졸", "심바스타틴"]);
  });

  it("같은 곳 효능군 중복은 참고", async () => {
    const r = await checkMeds(makeData(ds), "under65", [
      { item_seq: "S000000005", received_from: "OO내과" }, { item_seq: "S000000008", received_from: "OO내과" }]);
    expect(rulesOf(r)).toEqual(["R3_SAME"]);
    expect(r.findings[0].body).toContain("에소메프라졸정 20mg과 라베프라졸정 10mg은");
  });

  it("받은 곳 모르면 물어보기", async () => {
    const r = await checkMeds(makeData(ds), "under65", [{ item_seq: "S000000011" }, { item_seq: "S000000103" }]);
    expect(rulesOf(r)).toEqual(["R3"]);
  });

  it("같은 성분은 효능군 중복으로 또 알리지 않음", async () => {
    const r = await checkMeds(makeData(ds), "under65", [
      { item_seq: "S000000005", received_from: "OO내과" }, { item_seq: "S000000007", received_from: "정형외과" }]);
    expect(rulesOf(r)).toEqual(["R2"]);
  });

  it("노인주의는 65세 이상만", async () => {
    const items = [{ item_seq: "S000000014", received_from: "정신건강의학과" }];
    expect(rulesOf(await checkMeds(makeData(ds), "65+", items))).toEqual(["R4"]);
    expect(rulesOf(await checkMeds(makeData(ds), "under65", items))).toEqual([]);
  });

  it("같은 약은 한 번만", async () => {
    const r = await checkMeds(makeData(ds), "under65", [{ item_seq: "S000000001" }, { item_seq: "S000000001" }]);
    expect(r.med_count).toBe(1);
  });

  it("다제약물 기준", async () => {
    const four = Array.from({ length: 4 }, (_, i) => ({ item_seq: null, display_name: `약${i}` }));
    expect(rulesOf(await checkMeds(makeData(ds), "65+", four))).toEqual([]);
    const ten = Array.from({ length: 10 }, (_, i) => ({ item_seq: null, display_name: `약${i}` }));
    const r = await checkMeds(makeData(ds), "65+", ten);
    expect(rulesOf(r)).toEqual(["R5_PROGRAM"]);
    expect(r.findings[0].title).toBe("약을 10개 드시고 계세요");
  });

  it("엄격 모드는 감수 전 문구를 숨김", async () => {
    const r = await checkMeds(makeData(ds), "65+", DEMO, { strictApproval: true });
    expect(r.findings.every((f) => f.title === "확인이 필요한 항목이 있어요")).toBe(true);
  });
});

describe.each(DATASETS)("검색과 봉투 글자 (%s)", (ds) => {
  it("앞부분·초성·오타", async () => {
    const d = makeData(ds);
    expect((await searchDrugs(d, "에소메"))[0].row[1]).toMatch(/^에소메프라졸/);
    expect((await searchDrugs(d, "ㅇㅅㅁ")).map((h) => h.row[0])).toContain("S000000005");
    expect((await searchDrugs(d, "에소메프라줄"))[0].row[1]).toMatch(/^에소메프라졸/);
    expect(await searchDrugs(d, "가나다라마바")).toEqual([]);
    expect(await searchDrugs(d, "에")).toEqual([]);
  });

  it("검색은 그 초성 조각만 받는다", async () => {
    const log: string[] = [];
    await searchDrugs(makeData(ds, log), "에소메");
    expect(log.filter((p) => p.startsWith("search/"))).toEqual(ds === "sample"
      ? ["search/3147-3145.json"]
      : ["search/3147-3145-3141.json", "search/3147-3145.json"]); // 세 글자 조각 + 짧은 이름만 남은 두 글자 파일
    expect(log.some((p) => p.startsWith("drug/"))).toBe(false);
  });

  it("함량 분리", () => {
    expect(splitDose("라베프라졸정 10밀리그램")[1]).toBe("10mg");
    expect(splitDose("암로디핀정5㎎")[1]).toBe("5mg");
  });

  it("함량이 맞는 후보를 먼저, 잡음 줄은 건너뜀", async () => {
    const out = await matchLines(makeData(ds), [
      "OO약국 조제일자 2026.10.10",
      "에소메프라졸정 40mg 1일 1회",
      "아침 식후 30분 복용하세요 총 30일분",
      "라베프라졸정 10밀리그램",
    ]);
    expect(out.map((l) => l.candidates[0].item_seq)).toEqual(["S000000006", "S000000008"]);
  });

  it("봉투 후보를 보여 줄 때는 품목 상세를 받지 않는다", async () => {
    const log: string[] = [];
    await matchLines(makeData(ds, log), ["에소메프라졸정 40mg", "라베프라졸정 10mg"]);
    expect(log.some((p) => p.startsWith("drug/"))).toBe(false);
  });
});

describe.each(DATASETS)("봉투 줄 정리 (%s)", (ds) => {
  it("약국명·전화·주소·날짜·금액 줄은 버린다", () => {
    for (const line of [
      "행복약국", "OO온누리약국 약사 홍길동", "☎ 02-123-4567", "TEL 031)123-4567", "전화 010 1234 5678",
      "서울특별시 강남구 테헤란로 123", "경기도 성남시 분당구", "판교역로 235 3층",
      "조제일자 2026.10.10", "2026년 10월 10일", "10월 10일 교부", "본인부담금 3,500원", "약제비 총액 12,000",
      "합계 4500원", "사업자등록번호 123-45-67890", "환자성명 김OO",
    ]) {
      expect(isNoiseLine(line) || prepareLine(line).noise, line).toBe(true);
    }
  });

  it("복용법만 있는 줄은 버리고, 약 이름 옆 복용법은 지운다", () => {
    for (const line of ["1일 3회 식후 30분", "아침 저녁 복용하세요", "1회 1정씩 하루 2번", "총 30일분", "취침 전 드세요"]) {
      expect(prepareLine(line).noise, line).toBe(true);
    }
    const l = prepareLine("에소메프라졸정 40mg 1일 1회 아침 식후 30분 복용");
    expect(l.noise).toBe(false);
    expect(l.text).toBe("에소메프라졸정");
    expect(l.dose).toBe("40mg");
  });

  it("약 이름 줄은 잡음으로 보지 않는다", () => {
    for (const line of ["아세트아미노펜서방정 650mg", "셀레콕시브캡슐 200mg", "[샘플] 종합감기약정", "1. 암로디핀정 5mg"]) {
      expect(isNoiseLine(line) || prepareLine(line).noise, line).toBe(false);
    }
  });

  it("한 줄에 붙은 약 두 개를 나눈다", () => {
    expect(splitDrugs("에소메프라졸정40mg 라베프라졸정10mg")).toEqual(["에소메프라졸정40mg", "라베프라졸정10mg"]);
    expect(splitDrugs("암로디핀정 5mg, 메트포르민정 500mg")).toEqual(["암로디핀정 5mg", "메트포르민정 500mg"]);
    expect(splitDrugs("에소메프라졸정/라베프라졸정")).toEqual(["에소메프라졸정", "라베프라졸정"]);
    expect(splitDrugs("암로디핀정 메트포르민정")).toEqual(["암로디핀정", "메트포르민정"]);
    expect(splitDrugs("에소메프라졸정 40mg 1일 1회")).toEqual(["에소메프라졸정 40mg 1일 1회"]);
    expect(splitDrugs("아세트아미노펜서방정 650mg")).toEqual(["아세트아미노펜서방정 650mg"]);
  });

  it("붙은 두 약을 각각 찾는다", async () => {
    const out = await matchLines(makeData(ds), ["에소메프라졸정40mg 라베프라졸정10mg", "암로디핀정 5mg, 메트포르민정 500mg"]);
    expect(out.map((l) => l.candidates[0].item_seq)).toEqual(["S000000006", "S000000008", "S000000001", "S000000002"]);
  });

  it("처방전 9자리 보험코드를 뽑는다 (전화·사업자번호·긴 숫자는 아님)", () => {
    expect(extractInsuranceCode("642102570 에소메프라졸정 40mg 1 1 30")).toBe("642102570");
    expect(extractInsuranceCode("1 645301220")).toBe("645301220");
    expect(extractInsuranceCode("02-1234-5678")).toBeNull();
    expect(extractInsuranceCode("123-45-67890")).toBeNull();
    expect(extractInsuranceCode("1234567890")).toBeNull();
    expect(extractInsuranceCode("에소메프라졸정 40mg")).toBeNull();
    expect(extractInsuranceCodes(["642102570 에소메프라졸정 40mg", "645301220", "642102570", "☎ 02-123-4567"]))
      .toEqual(["642102570", "645301220"]);
  });

  it("처방전 줄: 코드는 insurance_code로, 이름은 그대로 찾는다", async () => {
    const out = await matchLines(makeData(ds), [
      "OO내과의원 처방전",
      "1 642102570 에소메프라졸정 40mg 1 1 30",
      "2 671803460 라베프라졸정10mg 1.00 2 30",
      "교부일자 2026-10-10",
    ]);
    expect(out.map((l) => [l.insurance_code, l.candidates[0].item_seq])).toEqual([
      ["642102570", "S000000006"],
      ["671803460", "S000000008"],
    ]);
  });

  it("실제 봉투처럼 섞인 글자", async () => {
    const out = await matchLines(makeData(ds), [
      "건강약국",
      "서울특별시 종로구 종로 1",
      "TEL 02-765-4321",
      "김OO 님  조제일자 2026.10.10",
      "아침 점심 저녁 식후 30분",
      "에소메프라졸정 40mg 1일 1회 아침 식후",
      "셀레콕시브캡슐200mg 아세트아미노펜서방정650mg",
      "약제비 총액 12,300원 본인부담 3,700원",
    ]);
    expect(out.map((l) => l.candidates[0].item_seq)).toEqual(["S000000006", "S000000011", "S000000010"]);
    expect(out.every((l) => l.insurance_code === null)).toBe(true);
  });
});

describe("나뉜 검색 키", () => {
  it("나뉜 키를 두 글자로만 찾으면 한 글자 더 써 달라고 한다", async () => {
    const split = await searchDrugsOutcome(makeData("sample-split"), "에소");
    expect(split.needMore).toBe(true);
    expect(split.hits).toEqual([]); // 두 글자 파일에는 짧은 이름만 (샘플에는 없음)
    expect((await searchDrugsOutcome(makeData("sample-split"), "ㅇㅅ")).needMore).toBe(true);
    const plain = await searchDrugsOutcome(makeData("sample"), "에소");
    expect(plain.needMore).toBe(false);
    expect(plain.hits.length).toBeGreaterThan(0);
  });

  it("나뉘지 않은 키는 두 글자로도 찾는다", async () => {
    const r = await searchDrugsOutcome(makeData("sample-split"), "암로");
    expect(r.needMore).toBe(false);
    expect(r.hits[0].row[1]).toMatch(/^암로디핀/);
  });

  it("세 글자 조각이 없으면 받지 않는다", async () => {
    const log: string[] = [];
    expect(await searchDrugs(makeData("sample-split", log), "에소라")).toEqual([]);
    expect(log.filter((p) => p.startsWith("search/"))).toEqual(["search/3147-3145.json"]);
  });

  it("세 글자 초성 검색", async () => {
    expect((await searchDrugs(makeData("sample-split"), "ㅇㅅㅁ")).map((h) => h.row[0])).toContain("S000000005");
  });
});

describe("보험코드", () => {
  /** 샘플에는 보험코드가 없어서, 픽스처 위에 보험코드 조각 하나를 얹는다 */
  function withInsurance(code: string, seq: string, meta?: (m: Meta) => Meta, log?: string[]) {
    const base = fileLoader("sample", log);
    return new DrugData(async (path) => {
      if (path === "meta.json") {
        const m = (await base(path)) as Meta;
        return meta ? meta(m) : m;
      }
      if (path === `insurance/${bucket(code, 256)}.json`) {
        log?.push(path);
        return { [code]: seq };
      }
      return base(path);
    });
  }

  it("보험코드로 품목을 찾는다", async () => {
    const d = withInsurance("642102570", "S000000006");
    expect((await d.insurance("642102570"))?.item_seq).toBe("S000000006");
    expect(await d.insurance("600000000")).toBeNull();
  });

  it("예전 데이터(보험코드 조각 없음)면 찾지 않는다", async () => {
    const log: string[] = [];
    const d = withInsurance("642102570", "S000000006",
      (m) => ({ ...m, shards: { ...m.shards, insurance: undefined } }), log);
    expect(await d.insurance("642102570")).toBeNull();
    expect(log.some((p) => p.startsWith("insurance/"))).toBe(false);
  });

  it("처방전 줄의 보험코드 품목을 맨 앞 확실한 후보로", async () => {
    // 이름은 40mg 이지만 보험코드는 20mg 품목을 가리킴 → 코드가 이긴다
    const d = withInsurance("642102570", "S000000005");
    const out = await matchLines(d, ["1 642102570 에소메프라졸정 40mg 1 1 30"]);
    expect(out[0].candidates[0]).toMatchObject({ item_seq: "S000000005", score: 1 });
    expect(out[0].candidates.filter((c) => c.item_seq === "S000000005")).toHaveLength(1);
  });

  it("이름 후보에 없는 보험코드 품목은 상세를 받아 후보로 만든다", async () => {
    const d = withInsurance("642102570", "S000000012");
    const out = await matchLines(d, ["1 642102570 에소메프라졸정 40mg 1 1 30"]);
    expect(out[0].candidates[0]).toMatchObject({ item_seq: "S000000012", score: 1 });
  });
});
