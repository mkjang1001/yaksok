/**
 * 약속 사진 글자 읽기 Worker.
 * POST /ocr (multipart `image`) → Google Cloud Vision TEXT_DETECTION → { "lines": [...] }
 *
 * - 사진과 읽은 글자는 저장하지 않고, 로그에도 남기지 않는다 (console 호출 없음).
 * - 무료 한도를 넘지 않게 IP별·전체 요청 수를 센다. IP는 해시로만, 하루 뒤 사라지게 저장한다.
 */

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface Env {
  GOOGLE_VISION_API_KEY?: string;
  ALLOWED_ORIGINS?: string;
  DAILY_LIMIT?: string;
  RATE_LIMIT?: KVLike;
}

export interface Deps {
  /** Vision 호출용 fetch (테스트에서 가짜로 바꾼다) */
  fetch: typeof fetch;
  /** 지금 시각 (테스트용) */
  now: () => number;
}

export const MAX_BYTES = 2 * 1024 * 1024;
export const PER_MINUTE = 10;
export const PER_DAY = 50;
export const DEFAULT_DAILY_LIMIT = 30;
export const DEFAULT_ORIGINS = ["https://mkjang1001.github.io", "https://yaksok.pages.dev", "http://localhost:5173", "http://localhost:4173"];
const VISION_URL = "https://vision.googleapis.com/v1/images:annotate";

const MSG = {
  notFound: "없는 주소예요.",
  method: "사진은 POST로 보내 주세요.",
  origin: "허용되지 않은 곳에서 온 요청이에요.",
  noImage: "사진이 없어요. 다시 찍어 주세요.",
  tooBig: "사진이 너무 커요. 다시 찍어 주세요.",
  badType: "JPEG나 PNG 사진만 읽을 수 있어요.",
  perMinute: "잠깐 쉬었다가 다시 찍어 주세요. 1분에 10장까지 읽을 수 있어요.",
  perDay: "오늘은 사진을 더 읽을 수 없어요. 봉투에 적힌 약 이름을 직접 써 주세요.",
  global: "오늘 사진 읽기 한도가 다 찼어요. 봉투에 적힌 약 이름을 직접 써 주세요.",
  config: "사진 읽기가 아직 준비되지 않았어요. 약 이름을 직접 써 주세요.",
  vision: "사진 글자를 읽지 못했어요. 다시 찍거나 약 이름을 직접 써 주세요.",
};

function allowedOrigins(env: Env): string[] {
  const raw = env.ALLOWED_ORIGINS?.trim();
  if (!raw) return DEFAULT_ORIGINS;
  return raw.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const h: Record<string, string> = { Vary: "Origin" };
  if (origin && allowedOrigins(env).includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** 파일 앞부분으로 JPEG/PNG를 가린다 (Content-Type은 믿지 않는다) */
export function imageKind(bytes: Uint8Array): "jpeg" | "png" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return "png";
  return null;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** 한국 시간 기준 날짜 (하루 한도가 자정에 풀리도록) */
function kstDay(now: number): string {
  return new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
}

type LimitResult = { ok: true } | { ok: false; message: string; retryAfter: number };

/**
 * 한도를 확인하고, 통과하면 바로 센다 (Vision 호출 전에 세어서 동시에 몰려도 덜 넘치게).
 * KV는 대략적인 카운터라 아주 짧은 순간에는 한두 장 넘을 수 있다 — 전체 한도는 무료 한도보다 넉넉히 낮게 둔다.
 */
export async function checkLimits(env: Env, ip: string, now: number): Promise<LimitResult> {
  const kv = env.RATE_LIMIT;
  if (!kv) return { ok: false, message: MSG.config, retryAfter: 3600 }; // 셀 수 없으면 무료 한도를 지킬 수 없으니 막는다
  const dailyLimit = Number(env.DAILY_LIMIT) > 0 ? Number(env.DAILY_LIMIT) : DEFAULT_DAILY_LIMIT;
  const day = kstDay(now);
  const minute = Math.floor(now / 60_000);
  const ipHash = await sha256Hex(`${day}:${ip}`);
  const keys = {
    global: `g:${day}`,
    ipDay: `d:${day}:${ipHash}`,
    ipMin: `m:${minute}:${ipHash}`,
  };
  const [g, d, m] = await Promise.all([kv.get(keys.global), kv.get(keys.ipDay), kv.get(keys.ipMin)]);
  const n = (v: string | null) => Number(v) || 0;
  const secondsToMidnight = Math.max(60, Math.ceil((86_400_000 - ((now + 9 * 3600_000) % 86_400_000)) / 1000));
  if (n(g) >= dailyLimit) return { ok: false, message: MSG.global, retryAfter: secondsToMidnight };
  if (n(d) >= PER_DAY) return { ok: false, message: MSG.perDay, retryAfter: secondsToMidnight };
  if (n(m) >= PER_MINUTE) return { ok: false, message: MSG.perMinute, retryAfter: 60 - Math.floor((now % 60_000) / 1000) };
  // KV는 만료 시간이 최소 60초
  await Promise.all([
    kv.put(keys.global, String(n(g) + 1), { expirationTtl: 2 * 86_400 }),
    kv.put(keys.ipDay, String(n(d) + 1), { expirationTtl: 2 * 86_400 }),
    kv.put(keys.ipMin, String(n(m) + 1), { expirationTtl: 120 }),
  ]);
  return { ok: true };
}

/** Vision 응답 → 빈 줄 없는 글자 줄 목록 */
export function visionLines(body: unknown): string[] {
  const r = (body as { responses?: { fullTextAnnotation?: { text?: string }; textAnnotations?: { description?: string }[] }[] })
    ?.responses?.[0];
  const text = r?.fullTextAnnotation?.text ?? r?.textAnnotations?.[0]?.description ?? "";
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function callVision(bytes: Uint8Array, key: string, deps: Deps): Promise<string[] | null> {
  const res = await deps.fetch(`${VISION_URL}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{
        image: { content: toBase64(bytes) },
        features: [{ type: "TEXT_DETECTION" }],
        imageContext: { languageHints: ["ko"] },
      }],
    }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { responses?: { error?: unknown }[] };
  if (body?.responses?.[0]?.error) return null;
  return visionLines(body);
}

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const cors = corsHeaders(origin, env);
  const originOk = !!origin && allowedOrigins(env).includes(origin);

  if (url.pathname !== "/ocr") return json({ error: MSG.notFound }, 404, cors);
  if (request.method === "OPTIONS") {
    return originOk ? new Response(null, { status: 204, headers: cors }) : json({ error: MSG.origin }, 403, cors);
  }
  if (request.method !== "POST") return json({ error: MSG.method }, 405, cors);
  if (!originOk) return json({ error: MSG.origin }, 403, cors);

  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BYTES + 64 * 1024) return json({ error: MSG.tooBig }, 413, cors);

  let file: File | null = null;
  try {
    const form = await request.formData();
    const v = form.get("image");
    file = v instanceof File ? v : null;
  } catch {
    file = null;
  }
  if (!file || file.size === 0) return json({ error: MSG.noImage }, 400, cors);
  if (file.size > MAX_BYTES) return json({ error: MSG.tooBig }, 413, cors);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!imageKind(bytes)) return json({ error: MSG.badType }, 415, cors);

  const key = env.GOOGLE_VISION_API_KEY;
  if (!key || !env.RATE_LIMIT) return json({ error: MSG.config }, 503, cors);

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const limit = await checkLimits(env, ip, deps.now());
  if (!limit.ok) return json({ error: limit.message }, 429, { ...cors, "Retry-After": String(limit.retryAfter) });

  let lines: string[] | null = null;
  try {
    lines = await callVision(bytes, key, deps);
  } catch {
    lines = null;
  }
  if (lines === null) return json({ error: MSG.vision }, 502, cors);
  return json({ lines }, 200, cors);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env, { fetch: (input, init) => fetch(input, init), now: () => Date.now() });
  },
};
