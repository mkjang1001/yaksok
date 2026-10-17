import { describe, expect, it } from "vitest";
import { qrMatrix } from "./qr";
import { decodeShare, encodeShare, fromBase64Url, isLocked, MAX_DATA_CHARS, shareLink, ShareError, toBase64Url, type SharePayload } from "./share";

const SAMPLE: SharePayload = {
  ageBand: "65+",
  meds: [
    { item_seq: "S000000001", name: "", received_from: "OO내과" },
    { item_seq: "S000000010", name: "", received_from: "정형외과" },
    { item_seq: null, name: "파스(이름 모름)", received_from: "약국에서 산 약" },
    { item_seq: "S000000101", name: "", received_from: "" },
  ],
};

/** 실제 품목코드처럼 9자리 숫자 30개, 받은 곳 4군데 */
const THIRTY: SharePayload = {
  ageBand: "under65",
  meds: Array.from({ length: 30 }, (_, i) => ({
    item_seq: String(200000000 + ((i * 7919373) % 99999999)),
    name: "",
    received_from: ["서울OO내과의원", "정형외과", "약국에서 산 약", "OO대학교병원 심장내과"][i % 4],
  })),
};

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof ShareError ? e.code : `other: ${String(e)}`;
  }
  return "no error";
}

describe("공유 링크", () => {
  it("왕복 인코딩", async () => {
    const data = await encodeShare(SAMPLE);
    expect(data).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(isLocked(data)).toBe(false);
    expect(await decodeShare(data)).toEqual(SAMPLE);
  });

  it("빈 목록·65세 미만도 그대로", async () => {
    const p: SharePayload = { ageBand: "under65", meds: [] };
    expect(await decodeShare(await encodeShare(p))).toEqual(p);
  });

  it("숫자 4자리로 잠그고 풀기", async () => {
    const data = await encodeShare(SAMPLE, "0427");
    expect(isLocked(data)).toBe(true);
    // 잠긴 링크에는 약 이름·받은 곳이 그대로 보이지 않는다
    expect(new TextDecoder().decode(fromBase64Url(data))).not.toContain("S000000001");
    expect(await decodeShare(data, "0427")).toEqual(SAMPLE);
  });

  it("틀린 숫자·숫자 없음은 wrong-pin", async () => {
    const data = await encodeShare(SAMPLE, "1234");
    expect(await codeOf(decodeShare(data, "1235"))).toBe("wrong-pin");
    expect(await codeOf(decodeShare(data))).toBe("wrong-pin");
  });

  it("4자리 숫자가 아니면 잠그지 않는다", async () => {
    await expect(encodeShare(SAMPLE, "12a4")).rejects.toThrow();
    await expect(encodeShare(SAMPLE, "12345")).rejects.toThrow();
  });

  it("손상된 데이터는 corrupt", async () => {
    const data = await encodeShare(SAMPLE);
    expect(await codeOf(decodeShare(""))).toBe("corrupt");
    expect(await codeOf(decodeShare("!!!"))).toBe("corrupt");
    expect(await codeOf(decodeShare(data.slice(0, Math.floor(data.length / 2))))).toBe("corrupt");
    expect(await codeOf(decodeShare("A".repeat(MAX_DATA_CHARS + 1)))).toBe("corrupt");
    // 형식은 맞지만 내용이 엉뚱한 경우
    const junk = toBase64Url(new Uint8Array([0x10, ...new TextEncoder().encode('[1,1,["a"],[["x",5]]]')]));
    expect(await codeOf(decodeShare(junk))).toBe("corrupt");
    const bytes = fromBase64Url(data);
    bytes[bytes.length - 3] ^= 0xff;
    expect(await codeOf(decodeShare(toBase64Url(bytes)))).toBe("corrupt");
  });

  it("잠긴 데이터가 손상되어도 오류로 끝난다", async () => {
    const data = await encodeShare(SAMPLE, "5555");
    const bytes = fromBase64Url(data);
    bytes[30] ^= 0x01;
    expect(await codeOf(decodeShare(toBase64Url(bytes), "5555"))).toBe("wrong-pin");
    expect(await codeOf(decodeShare(data.slice(0, 20), "5555"))).toBe("corrupt");
    expect(() => isLocked(data.slice(0, 20))).toThrow(ShareError);
  });

  it("약 30개도 링크가 짧다", async () => {
    const open = await encodeShare(THIRTY);
    const locked = await encodeShare(THIRTY, "9876");
    expect(await decodeShare(open)).toEqual(THIRTY);
    expect(await decodeShare(locked, "9876")).toEqual(THIRTY);
    const link = shareLink(locked, "https://mkjang1001.github.io/yaksok/#/result");
    expect(link.startsWith("https://mkjang1001.github.io/yaksok/#/shared/")).toBe(true);
    expect(open.length).toBeLessThan(500);
    expect(link.length).toBeLessThan(600);
    // 화면에 띄워 휴대폰 카메라로 읽을 만한 QR 크기 (버전 20 = 97칸 이하)
    expect(qrMatrix(link)!.length).toBeLessThanOrEqual(97);
  });
});

describe("QR코드", () => {
  it("크기는 버전에 맞고 찾기 패턴이 세 귀퉁이에 있다", () => {
    const m = qrMatrix("https://example.com/#/shared/abc")!;
    expect((m.length - 17) % 4).toBe(0);
    const n = m.length;
    for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      expect(m[y][x] && m[y + 6][x + 6] && m[y + 3][x + 3]).toBe(true);
      expect(m[y + 1][x + 1]).toBe(false);
    }
  });

  it("너무 긴 데이터는 null", () => {
    expect(qrMatrix("a".repeat(3000))).toBeNull();
  });
});
