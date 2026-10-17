/**
 * 보호자 공유 링크 — 서버에 아무것도 저장하지 않는다.
 * 약 목록(품목코드·코드 없는 약 이름·받은 곳)과 나이대만 짧게 적어 압축한 뒤 주소의 # 뒤에 붙인다.
 * # 뒤는 브라우저가 서버로 보내지 않으므로 호스팅 기록에 남지 않는다.
 *
 * 형식: base64url( [머리 1바이트] + 본문 )
 *   머리: 상위 4비트 = 형식 버전, 0x01 = deflate 압축, 0x02 = 숫자 잠금
 *   잠금이면 본문 = salt(16) + iv(12) + AES-GCM 암호문, 풀면 (압축된) JSON
 */
import type { Med, Profile } from "../types";

export interface SharedMed { item_seq: string | null; name: string; received_from: string }
export interface SharePayload { ageBand: Profile["ageBand"]; meds: SharedMed[] }

export type ShareErrorCode = "corrupt" | "wrong-pin" | "unsupported";
export class ShareError extends Error {
  constructor(public code: ShareErrorCode, message: string) {
    super(message);
  }
}

const VERSION = 1;
const FLAG_DEFLATE = 0x01;
const FLAG_LOCKED = 0x02;
const PBKDF2_ITERATIONS = 600_000;
const SALT_LEN = 16;
const IV_LEN = 12;
/** 이보다 긴 링크 데이터는 열지 않는다 (손상·악용 방지) */
export const MAX_DATA_CHARS = 6000;
export const MAX_MEDS = 100;
const MAX_TEXT = 60;

const corrupt = () => new ShareError("corrupt", "링크가 잘렸거나 손상되었어요. 보내 준 분께 링크를 다시 받아 주세요.");

/* ---------- 직렬화: [버전, 나이대, [받은 곳...], [[코드 또는 "~이름", 받은곳 번호]...]] ---------- */

function serialize(p: SharePayload): string {
  const places: string[] = [];
  const meds = p.meds.slice(0, MAX_MEDS).map((m) => {
    const place = m.received_from.slice(0, MAX_TEXT);
    let idx = places.indexOf(place);
    if (idx < 0) idx = places.push(place) - 1;
    return [m.item_seq ?? "~" + m.name.slice(0, MAX_TEXT), idx];
  });
  return JSON.stringify([VERSION, p.ageBand === "under65" ? 0 : 1, places, meds]);
}

function deserialize(text: string): SharePayload {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw corrupt();
  }
  if (!Array.isArray(raw) || raw[0] !== VERSION || !Array.isArray(raw[2]) || !Array.isArray(raw[3])) throw corrupt();
  const places = raw[2] as unknown[];
  const list = raw[3] as unknown[];
  if (list.length > MAX_MEDS || !places.every((s) => typeof s === "string" && s.length <= MAX_TEXT)) throw corrupt();
  const meds = list.map((e): SharedMed => {
    if (!Array.isArray(e) || typeof e[0] !== "string" || !e[0] || e[0].length > MAX_TEXT + 1
      || !Number.isInteger(e[1]) || e[1] < 0 || e[1] >= places.length) throw corrupt();
    const [id, idx] = e as [string, number];
    const place = places[idx] as string;
    return id.startsWith("~")
      ? { item_seq: null, name: id.slice(1), received_from: place }
      : { item_seq: id, name: "", received_from: place };
  });
  return { ageBand: raw[1] === 0 ? "under65" : "65+", meds };
}

/* ---------- 바이트 도구 ---------- */

export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw corrupt();
  let bin: string;
  try {
    bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  } catch {
    throw corrupt();
  }
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

const canDeflate = () => typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function pinKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

export const isValidPin = (pin: string) => /^\d{4}$/.test(pin);

/* ---------- 공개 함수 ---------- */

/** 공유 데이터 문자열(주소 # 뒤에 붙일 부분)을 만든다. pin을 주면 4자리 숫자로 잠근다. */
export async function encodeShare(p: SharePayload, pin?: string): Promise<string> {
  if (pin !== undefined && !isValidPin(pin)) throw new Error("숫자 4자리를 넣어 주세요.");
  let body = new TextEncoder().encode(serialize(p));
  let flags = 0;
  if (canDeflate()) {
    const packed = await pipe(body, new CompressionStream("deflate"));
    if (packed.length < body.length) { body = packed; flags |= FLAG_DEFLATE; }
  }
  if (pin !== undefined) {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await pinKey(pin, salt), body);
    body = concat(salt, iv, new Uint8Array(cipher));
    flags |= FLAG_LOCKED;
  }
  return toBase64Url(concat(new Uint8Array([(VERSION << 4) | flags]), body));
}

function header(data: string): { flags: number; body: Uint8Array } {
  if (!data || data.length > MAX_DATA_CHARS) throw corrupt();
  const bytes = fromBase64Url(data);
  if (bytes.length < 2 || bytes[0] >> 4 !== VERSION) throw corrupt();
  const flags = bytes[0] & 0x0f;
  if (flags & FLAG_LOCKED && bytes.length < 1 + SALT_LEN + IV_LEN + 16 + 2) throw corrupt();
  return { flags, body: bytes.subarray(1) };
}

/** 숫자로 잠긴 링크인지 (데이터가 손상되었으면 ShareError) */
export function isLocked(data: string): boolean {
  return (header(data).flags & FLAG_LOCKED) !== 0;
}

/** 공유 데이터를 푼다. 잠긴 링크인데 숫자가 틀리면 code="wrong-pin" */
export async function decodeShare(data: string, pin?: string): Promise<SharePayload> {
  const { flags, body: head } = header(data);
  let body = head;
  if (flags & FLAG_LOCKED) {
    if (pin === undefined || !isValidPin(pin)) throw new ShareError("wrong-pin", "숫자 4자리를 넣어 주세요.");
    const salt = body.subarray(0, SALT_LEN);
    const iv = body.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    try {
      body = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await pinKey(pin, salt), body.subarray(SALT_LEN + IV_LEN)));
    } catch {
      throw new ShareError("wrong-pin", "숫자가 맞지 않아요. 보내 준 분께 숫자 4자리를 다시 확인해 주세요. 그래도 안 되면 링크가 잘리지 않았는지 확인해 주세요.");
    }
  }
  if (flags & FLAG_DEFLATE) {
    if (!canDeflate()) throw new ShareError("unsupported", "이 브라우저로는 열 수 없어요. 휴대폰의 기본 브라우저나 크롬으로 열어 주세요.");
    try {
      body = await pipe(body, new DecompressionStream("deflate"));
    } catch {
      throw corrupt();
    }
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw corrupt();
  }
  return deserialize(text);
}

export function payloadFromMeds(meds: Med[], profile: Profile): SharePayload {
  return {
    ageBand: profile.ageBand,
    meds: meds.map((m) => ({ item_seq: m.item_seq, name: m.item_seq ? "" : m.name, received_from: m.received_from })),
  };
}

/** 지금 열린 앱 주소 기준으로 공유 링크를 만든다 */
export function shareLink(data: string, base = window.location.href): string {
  return base.split("#")[0] + "#/shared/" + data;
}
