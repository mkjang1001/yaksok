/**
 * 화면이 쓰는 기능 모음. 서버 없이 브라우저 안에서 처리한다.
 * 약 정보는 정적 조각 파일에서 필요한 것만 받는다 (lib/data.ts).
 */
import { DataError, drugData } from "./data";
import { idb } from "./idb";
import { checkMeds } from "./rules";
import { matchLines, rowToDrug, searchDrugs } from "./search";
import type { CheckResult, Drug, Med, OcrLine, Profile } from "../types";

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

  ocrImage: (image: Blob) => wrap(async (): Promise<OcrLine[]> => {
    if (!OCR_URL) throw new ApiError(503, "사진 인식이 아직 연결되지 않았어요. 봉투에 적힌 약 이름을 아래에 써 주세요.");
    const form = new FormData();
    form.append("image", image, "bag.jpg");
    const res = await fetch(OCR_URL, { method: "POST", body: form });
    if (!res.ok) throw new ApiError(res.status, "사진 인식에 실패했어요. 다시 찍거나 글자를 직접 써 주세요.");
    const body = (await res.json()) as { lines: string[] };
    return matchLines(drugData, body.lines);
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

/** 업로드 전에 사진 긴 변을 1600px로 줄인다 (설계서 B7 1단계). */
export async function shrinkImage(file: File, maxSide = 1600): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("사진을 처리하지 못했어요."))), "image/jpeg", 0.85),
  );
}
