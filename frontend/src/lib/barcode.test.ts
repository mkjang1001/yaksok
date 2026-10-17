import { describe, expect, it } from "vitest";
import { checkTypedCode, createRepeatGuard, isValidEan, scannedToKey } from "./barcode";

describe("isValidEan", () => {
  it("맞는 EAN-13·EAN-8 체크 숫자를 통과시킨다", () => {
    expect(isValidEan("4006381333931")).toBe(true);
    expect(isValidEan("8801234567893")).toBe(true);
    expect(isValidEan("8800000000107")).toBe(true);
    expect(isValidEan("96385074")).toBe(true);
    expect(isValidEan("73513537")).toBe(true);
  });

  it("체크 숫자가 틀리면 거른다", () => {
    expect(isValidEan("4006381333932")).toBe(false);
    expect(isValidEan("8800000000101")).toBe(false);
    expect(isValidEan("96385075")).toBe(false);
  });

  it("자리 수가 다르거나 숫자가 아니면 거른다", () => {
    expect(isValidEan("")).toBe(false);
    expect(isValidEan("123456789012")).toBe(false);
    expect(isValidEan("40063813339310")).toBe(false);
    expect(isValidEan("400638133393a")).toBe(false);
  });
});

describe("scannedToKey", () => {
  it("EAN 값은 그대로 쓴다", () => {
    expect(scannedToKey("8801234567893")).toBe("8801234567893");
    expect(scannedToKey(" 96385074 ")).toBe("96385074");
  });

  it("GTIN-14(앞자리 0)과 GS1-128 값에서 EAN-13을 뽑는다", () => {
    expect(scannedToKey("08801234567893")).toBe("8801234567893");
    expect(scannedToKey("010880123456789317261231\x1d10AB12")).toBe("8801234567893");
    expect(scannedToKey("<GS>0108801234567893172612311012")).toBe("8801234567893");
    expect(scannedToKey("01088012345678931726123110123")).toBe("8801234567893");
    expect(scannedToKey("(01)08801234567893(17)261231")).toBe("8801234567893");
    expect(scannedToKey("]C10108801234567893")).toBe("8801234567893");
  });

  it("체크섬이 틀리거나 약 바코드가 아니면 null", () => {
    expect(scannedToKey("8801234567890")).toBeNull();
    expect(scannedToKey("ABC-123")).toBeNull();
    expect(scannedToKey("12345")).toBeNull();
  });
});

describe("checkTypedCode", () => {
  it("8자리 미만은 아직 짧다", () => {
    expect(checkTypedCode("1234567")).toEqual({ kind: "short" });
  });

  it("8·13자리가 아니면 자리 수 오류", () => {
    expect(checkTypedCode("123456789012")).toEqual({ kind: "length" });
  });

  it("체크섬 결과를 함께 돌려준다", () => {
    expect(checkTypedCode("8801234567893")).toEqual({ kind: "ok", code: "8801234567893", checksumOk: true });
    expect(checkTypedCode("8801234567890")).toEqual({ kind: "ok", code: "8801234567890", checksumOk: false });
    expect(checkTypedCode("08801234567893")).toEqual({ kind: "ok", code: "8801234567893", checksumOk: true });
  });
});

describe("createRepeatGuard", () => {
  it("같은 바코드가 계속 보이면 처음 한 번만 조회한다", () => {
    const g = createRepeatGuard(1000);
    expect(g.shouldLookup("A", 0)).toBe(true);
    expect(g.shouldLookup("A", 300)).toBe(false);
    expect(g.shouldLookup("A", 900)).toBe(false);
    expect(g.shouldLookup("A", 1800)).toBe(false); // 계속 보이는 동안은 시간이 연장된다
  });

  it("한동안 안 보였다가 다시 보이면 다시 조회한다", () => {
    const g = createRepeatGuard(1000);
    expect(g.shouldLookup("A", 0)).toBe(true);
    expect(g.shouldLookup("A", 1500)).toBe(true);
  });

  it("다른 바코드는 바로 조회하고, reset 하면 처음부터", () => {
    const g = createRepeatGuard(1000);
    expect(g.shouldLookup("A", 0)).toBe(true);
    expect(g.shouldLookup("B", 100)).toBe(true);
    expect(g.shouldLookup("A", 200)).toBe(true);
    g.reset();
    expect(g.shouldLookup("A", 300)).toBe(true);
  });
});
