import { describe, expect, it, vi } from "vitest";
import { handle, imageKind, toBase64, visionLines, type Env, type KVLike } from "../src/index";

const ORIGIN = "https://mkjang1001.github.io";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const NOW = Date.UTC(2026, 9, 17, 3, 0, 0); // 한국 시간 낮 12시

class MemoryKV implements KVLike {
  data = new Map<string, string>();
  async get(key: string) { return this.data.get(key) ?? null; }
  async put(key: string, value: string) { this.data.set(key, value); }
}

function makeEnv(over: Partial<Env> = {}): Env & { RATE_LIMIT: MemoryKV } {
  return { GOOGLE_VISION_API_KEY: "test-key", RATE_LIMIT: new MemoryKV(), ...over } as Env & { RATE_LIMIT: MemoryKV };
}

function visionOk(text = "에소메프라졸정 40mg\n\n라베프라졸정 10mg\n") {
  return vi.fn(async () => new Response(JSON.stringify({ responses: [{ fullTextAnnotation: { text } }] }), { status: 200 }));
}

function req(opts: { bytes?: Uint8Array | null; origin?: string | null; ip?: string; method?: string; path?: string; type?: string } = {}) {
  const { bytes = JPEG, origin = ORIGIN, ip = "1.2.3.4", method = "POST", path = "/ocr", type = "image/jpeg" } = opts;
  const headers = new Headers({ "CF-Connecting-IP": ip });
  if (origin) headers.set("Origin", origin);
  let body: FormData | undefined;
  if (method === "POST") {
    body = new FormData();
    if (bytes) body.append("image", new Blob([bytes], { type }), "bag.jpg");
  }
  return new Request(`https://ocr.example.workers.dev${path}`, { method, headers, body });
}

async function call(r: Request, env: Env, fetchImpl = visionOk(), now = NOW) {
  const res = await handle(r, env, { fetch: fetchImpl as unknown as typeof fetch, now: () => now });
  return { res, body: res.status === 204 ? null : await res.json() as { lines?: string[]; error?: string }, fetchImpl };
}

describe("사진 글자 읽기", () => {
  it("JPEG를 받아 Vision에 ko 힌트로 보내고 줄만 돌려준다", async () => {
    const env = makeEnv();
    const { res, body, fetchImpl } = await call(req(), env);
    expect(res.status).toBe(200);
    expect(body).toEqual({ lines: ["에소메프라졸정 40mg", "라베프라졸정 10mg"] });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("key=test-key");
    const sent = JSON.parse(init.body as string);
    expect(sent.requests[0].features).toEqual([{ type: "TEXT_DETECTION" }]);
    expect(sent.requests[0].imageContext).toEqual({ languageHints: ["ko"] });
    expect(sent.requests[0].image.content).toBe(toBase64(JPEG));
  });

  it("PNG도 받는다", async () => {
    const { res } = await call(req({ bytes: PNG, type: "image/png" }), makeEnv());
    expect(res.status).toBe(200);
  });

  it("JPEG/PNG가 아니면 415 (Content-Type이 그럴듯해도)", async () => {
    const gif = new TextEncoder().encode("GIF89a....");
    const { res, body, fetchImpl } = await call(req({ bytes: gif, type: "image/jpeg" }), makeEnv());
    expect(res.status).toBe(415);
    expect(body?.error).toMatch(/JPEG나 PNG/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("2MB 넘으면 413", async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(JPEG);
    const { res, fetchImpl } = await call(req({ bytes: big }), makeEnv());
    expect(res.status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("사진이 없으면 400", async () => {
    const { res } = await call(req({ bytes: null }), makeEnv());
    expect(res.status).toBe(400);
  });

  it("Vision 오류는 502, 글자가 없으면 빈 목록", async () => {
    const fail = vi.fn(async () => new Response("{}", { status: 403 }));
    expect((await call(req(), makeEnv(), fail)).res.status).toBe(502);
    const inner = vi.fn(async () => new Response(JSON.stringify({ responses: [{ error: { code: 3 } }] })));
    expect((await call(req(), makeEnv(), inner)).res.status).toBe(502);
    const thrown = vi.fn(async () => { throw new Error("network"); });
    expect((await call(req(), makeEnv(), thrown)).res.status).toBe(502);
    const empty = vi.fn(async () => new Response(JSON.stringify({ responses: [{}] })));
    expect((await call(req(), makeEnv(), empty)).body).toEqual({ lines: [] });
  });

  it("키나 카운터 저장소가 없으면 503 (무료 한도를 지킬 수 없으면 막음)", async () => {
    expect((await call(req(), makeEnv({ GOOGLE_VISION_API_KEY: "" }))).res.status).toBe(503);
    expect((await call(req(), makeEnv({ RATE_LIMIT: undefined }))).res.status).toBe(503);
  });

  it("다른 주소나 다른 방식은 받지 않는다", async () => {
    expect((await call(req({ path: "/" }), makeEnv())).res.status).toBe(404);
    expect((await call(req({ method: "GET" }), makeEnv())).res.status).toBe(405);
  });
});

describe("CORS", () => {
  it("허용된 곳의 미리 묻기에는 204", async () => {
    const { res } = await call(req({ method: "OPTIONS", origin: "http://localhost:5173" }), makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("허용 안 된 곳은 403, Vision 호출 없음", async () => {
    const { res, fetchImpl } = await call(req({ origin: "https://evil.example" }), makeEnv());
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await call(req({ origin: null }), makeEnv())).res.status).toBe(403);
  });

  it("ALLOWED_ORIGINS 환경변수로 바꿀 수 있다", async () => {
    const env = makeEnv({ ALLOWED_ORIGINS: "https://a.example, https://b.example/" });
    expect((await call(req({ origin: "https://b.example" }), env)).res.status).toBe(200);
    expect((await call(req({ origin: ORIGIN }), env)).res.status).toBe(403);
  });
});

describe("요청 제한", () => {
  it("IP별 1분 10장, 다음 분에는 다시 된다", async () => {
    const env = makeEnv({ DAILY_LIMIT: "1000" });
    for (let i = 0; i < 10; i++) expect((await call(req(), env)).res.status).toBe(200);
    const { res, body, fetchImpl } = await call(req(), env);
    expect(res.status).toBe(429);
    expect(body?.error).toMatch(/1분에 10장/);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await call(req({ ip: "5.6.7.8" }), env)).res.status).toBe(200);
    expect((await call(req(), env, visionOk(), NOW + 60_000)).res.status).toBe(200);
  });

  it("IP별 하루 50장", async () => {
    const env = makeEnv({ DAILY_LIMIT: "1000" });
    for (let i = 0; i < 50; i++) expect((await call(req(), env, visionOk(), NOW + i * 60_000)).res.status).toBe(200);
    const { res, body } = await call(req(), env, visionOk(), NOW + 50 * 60_000);
    expect(res.status).toBe(429);
    expect(body?.error).toMatch(/오늘은/);
  });

  it("전체 하루 한도 (기본 30), 한국 자정에 풀림", async () => {
    const env = makeEnv();
    for (let i = 0; i < 30; i++) {
      expect((await call(req({ ip: `10.0.0.${i}` }), env)).res.status).toBe(200);
    }
    const { res, body } = await call(req({ ip: "10.0.1.1" }), env);
    expect(res.status).toBe(429);
    expect(body?.error).toMatch(/한도/);
    const tomorrowKst = Date.UTC(2026, 9, 17, 15, 0, 1); // 10/18 00:00:01 KST
    expect((await call(req({ ip: "10.0.1.1" }), env, visionOk(), tomorrowKst)).res.status).toBe(200);
  });

  it("IP 원문은 저장하지 않는다", async () => {
    const env = makeEnv();
    await call(req({ ip: "203.0.113.77" }), env);
    for (const k of env.RATE_LIMIT.data.keys()) expect(k).not.toContain("203.0.113.77");
  });
});

describe("도우미 함수", () => {
  it("파일 종류 판별", () => {
    expect(imageKind(JPEG)).toBe("jpeg");
    expect(imageKind(PNG)).toBe("png");
    expect(imageKind(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("textAnnotations만 있어도 읽는다", () => {
    expect(visionLines({ responses: [{ textAnnotations: [{ description: "가\n 나 \n" }] }] })).toEqual(["가", "나"]);
    expect(visionLines(null)).toEqual([]);
  });

  it("큰 파일도 base64로 바꾼다", () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(atob(toBase64(big)).length).toBe(100_000);
  });
});
