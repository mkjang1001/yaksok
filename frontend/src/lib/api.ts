/**
 * 화면이 쓰는 기능 모음. 서버 없이 브라우저 안에서 처리한다.
 * 약 정보는 정적 조각 파일에서 필요한 것만 받는다 (lib/data.ts).
 */
import { DataError, drugData } from "./data";
import { idb } from "./idb";
import { checkMeds } from "./rules";
import { matchLines, rowToDrug, searchDrugs, type EnvelopeLine } from "./search";
import type { CheckResult, Drug, Med, Profile } from "../types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** 사진 인식 서버 주소 (선택). 비워 두면 봉투 글자 직접 입력만 쓴다. 응답 형식: { "lines": ["줄1", "줄2"] } */
const OCR_URL: string = import.meta.env.VITE_OCR_URL ?? "";
/** true면 감수 약사 승인이 없는 문구를 보여 주지 않는다. 시범 운영 전에 켠다. */
const STRICT = import.meta.env.VITE_STRICT_APPROVAL === "true";

export type SearchResult = ReturnType<typeof rowToDrug>;

const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DataError || e instanceof ApiError) throw e;
    throw new ApiError(0, "처리하지 못했어요. 잠시 뒤 다시 해 주세요.");
  }
};

export const api = {
  ocrAvailable: !!OCR_URL,

  search: (q: string) => wrap(async () => (await searchDrugs(drugData, q)).map((h) => rowToDrug(h.row))),

  /** 목록에 넣을 때 그 약 하나의 상세(성분 포함)만 받는다 */
  drug: (itemSeq: string) => wrap(async () => {
    const d = await drugData.drug(itemSeq);
    if (!d) throw new ApiError(404, "약 정보를 찾지 못했어요.");
    return d;
  }),

  barcode: (code: string) => wrap(async (): Promise<Drug> => {
    const d = await drugData.barcode(code.trim());
    if (!d) throw new ApiError(404, "이 바코드의 약을 찾지 못했어요. 이름으로 찾아 주세요.");
    return d;
  }),

  /** 사진을 글자 읽기 서버(worker/)에 보내 줄을 받고, 약 매칭은 이 기기에서 한다. 서버는 사진·글자를 저장하지 않는다. */
  ocrImage: (image: Blob) => wrap(async (): Promise<EnvelopeLine[]> => {
    if (!OCR_URL) throw new ApiError(503, OCR_MSG.off);
    const form = new FormData();
    form.append("image", image, image.type === "image/png" ? "bag.png" : "bag.jpg");
    let res: Response;
    try {
      res = await fetch(OCR_URL, { method: "POST", body: form });
    } catch {
      throw new ApiError(0, OCR_MSG.network);
    }
    if (!res.ok) throw new ApiError(res.status, await ocrErrorMessage(res));
    const body = (await res.json().catch(() => null)) as { lines?: unknown } | null;
    const lines = Array.isArray(body?.lines) ? body.lines.filter((l): l is string => typeof l === "string") : null;
    if (!lines) throw new ApiError(502, OCR_MSG.failed);
    return matchLines(drugData, lines);
  }),

  ocrText: (text: string) => wrap(() => matchLines(drugData, text.split(/\r?\n/))),

  check: (profile: Profile, meds: Med[]) => wrap((): Promise<CheckResult> =>
    checkMeds(drugData, profile.ageBand,
      meds.map((m) => ({ item_seq: m.item_seq, display_name: m.name, received_from: m.received_from })),
      { strictApproval: STRICT })),

  /** 도우미 모드 통계는 서버가 없으니 이 기기 안에 기관별로 쌓는다 (개인 정보 없음) */
  stat: (body: { org_code: string; med_count: number; count_red: number; count_amber: number; count_grey: number }) =>
    wrap(async () => {
      const key = `stats:${body.org_code}`;
      const prev = (await idb.get<OrgStats>(key)) ?? { checks: 0, meds: 0, withRed: 0, withAmber: 0 };
      await idb.set(key, {
        checks: prev.checks + 1,
        meds: prev.meds + body.med_count,
        withRed: prev.withRed + (body.count_red > 0 ? 1 : 0),
        withAmber: prev.withAmber + (body.count_amber > 0 ? 1 : 0),
      });
    }),

  orgStats: (orgCode: string) => idb.get<OrgStats>(`stats:${orgCode}`),
};

export interface OrgStats { checks: number; meds: number; withRed: number; withAmber: number }

export const OCR_MSG = {
  off: "사진 인식이 아직 연결되지 않았어요. 봉투에 적힌 약 이름을 아래에 써 주세요.",
  network: "인터넷이 연결되지 않아 사진을 보내지 못했어요. 연결을 확인하거나 약 이름을 직접 써 주세요.",
  limit: "오늘은 사진 읽기를 더 할 수 없어요. 봉투에 적힌 약 이름을 아래에 직접 써 주세요.",
  tooBig: "사진이 너무 커요. 다시 찍어 주세요.",
  failed: "사진 글자를 읽지 못했어요. 다시 찍거나 약 이름을 아래에 직접 써 주세요.",
};

/** 서버가 보낸 한국어 안내가 있으면 그것을, 없으면 상태별 기본 안내 */
async function ocrErrorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const fromServer = typeof body?.error === "string" && /[가-힣]/.test(body.error) ? body.error : null;
  if (res.status === 429) return fromServer ?? OCR_MSG.limit;
  if (res.status === 413) return OCR_MSG.tooBig;
  if (res.status === 503) return fromServer ?? OCR_MSG.off;
  return fromServer ?? OCR_MSG.failed;
}

export class ImageCheckError extends Error {
  constructor(public reason: "dark" | "small" | "unreadable", message: string) {
    super(message);
  }
}

export const IMAGE_MIN_SIDE = 600;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** 평균 밝기(0~255)가 이보다 낮으면 너무 어두운 사진 */
export const IMAGE_DARK_LUMA = 55;

/** 캔버스 일부를 작게 줄여 평균 밝기를 잰다 */
function averageLuma(source: CanvasImageSource, width: number, height: number): number | null {
  const size = 32;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height, 0, 0, size, size);
  try {
    const { data } = ctx.getImageData(0, 0, size, size);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return sum / (size * size);
  } catch {
    return null;
  }
}

/**
 * 업로드 전에 사진을 손본다 (설계서 B7 1단계).
 * - 긴 변을 1600px로 줄이고 JPEG로 다시 저장한다. 캔버스에 다시 그려 저장하므로
 *   EXIF(촬영 위치·기기 정보)는 새 파일에 들어가지 않는다. 방향은 createImageBitmap이 EXIF대로 돌려서 그린다.
 * - 너무 작거나 어두우면 ImageCheckError로 다시 찍도록 안내한다.
 * - 2MB가 넘으면 품질을 낮춰 다시 저장한다 (서버 한도 2MB).
 */
export async function shrinkImage(file: Blob, maxSide = 1600): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new ImageCheckError("unreadable", "사진을 열지 못했어요. 다시 찍어 주세요.");
  }
  try {
    if (Math.max(bitmap.width, bitmap.height) < IMAGE_MIN_SIDE) {
      throw new ImageCheckError("small", "사진이 너무 작아요. 봉투에 조금 더 가까이 대고 다시 찍어 주세요.");
    }
    const luma = averageLuma(bitmap, bitmap.width, bitmap.height);
    if (luma !== null && luma < IMAGE_DARK_LUMA) {
      throw new ImageCheckError("dark", "사진이 너무 어두워요. 밝은 곳에서 다시 찍어 주세요.");
    }
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ImageCheckError("unreadable", "사진을 처리하지 못했어요.");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.7, 0.55]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!blob) break;
      if (blob.size <= IMAGE_MAX_BYTES) return blob;
    }
    throw new ImageCheckError("unreadable", "사진을 처리하지 못했어요. 다시 찍어 주세요.");
  } finally {
    bitmap.close();
  }
}
