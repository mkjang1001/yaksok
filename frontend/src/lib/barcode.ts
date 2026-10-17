/**
 * 약 상자 바코드 읽기.
 * - 순수 함수: EAN 체크섬, 읽은 값 → 조회 키, 같은 바코드 반복 조회 막기 (barcode.test.ts)
 * - 읽기 엔진: 브라우저 BarcodeDetector가 있으면 그것을, 없으면 zxing-wasm을 이때만 불러 쓴다.
 */

declare global {
  interface Window {
    BarcodeDetector?: {
      new (opts?: { formats: string[] }): { detect: (src: CanvasImageSource | ImageBitmap) => Promise<{ rawValue: string }[]> };
      getSupportedFormats?: () => Promise<string[]>;
    };
  }
}

/** EAN-8 / EAN-13 마지막 자리(체크 숫자)가 맞는지 */
export function isValidEan(code: string): boolean {
  if (!/^(\d{8}|\d{13})$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  // 체크 숫자 바로 앞자리부터 거꾸로 3, 1, 3, 1 … 을 곱한다 (EAN-8·13 공통)
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * 카메라로 읽은 값 → 약 DB 조회 키(EAN-13 또는 EAN-8). 쓸 수 없는 값이면 null.
 * Code128은 GS1-128(01 + GTIN-14 …)로 찍힌 경우가 많아 GTIN만 뽑아낸다.
 */
export function scannedToKey(raw: string): string | null {
  // "]C1" 같은 기호 식별자, FNC1(GS 글자 또는 zxing이 보여 주는 "<GS>"), 공백을 걷어낸다
  const text = raw.trim().replace(/^\][A-Za-z]\d/, "").replace(/<GS>|\x1d|\s/g, "");
  if (isValidEan(text)) return text;
  if (/^0\d{13}$/.test(text) && isValidEan(text.slice(1))) return text.slice(1);
  // GS1-128: (01) 다음 14자리가 GTIN. 뒤에 오는 유통기한·로트 번호는 보지 않는다
  const gtin14 = /^\(?01\)?(\d{14})/.exec(text)?.[1];
  if (gtin14 && gtin14[0] === "0" && isValidEan(gtin14.slice(1))) return gtin14.slice(1);
  return null;
}

export type TypedCode =
  | { kind: "short" }
  | { kind: "length" }
  | { kind: "ok"; code: string; checksumOk: boolean };

/** 손으로 쓴 숫자 확인. 자리 수가 맞으면 조회 키와 체크섬 결과를 돌려준다. */
export function checkTypedCode(input: string): TypedCode {
  const digits = input.replace(/\D/g, "");
  if (digits.length < 8) return { kind: "short" };
  // GTIN-14(앞자리 0)으로 적은 경우 EAN-13으로 맞춘다
  const code = digits.length === 14 && digits[0] === "0" ? digits.slice(1) : digits;
  if (code.length !== 8 && code.length !== 13) return { kind: "length" };
  return { kind: "ok", code, checksumOk: isValidEan(code) };
}

/**
 * 같은 바코드를 연속으로 여러 번 조회하지 않게 한다.
 * 같은 값이 계속 보이는 동안(windowMs 안에 다시 보이면)은 처음 한 번만 true.
 */
export function createRepeatGuard(windowMs = 4000) {
  let last: string | null = null;
  let lastSeen = -Infinity;
  return {
    shouldLookup(code: string, now: number): boolean {
      const repeat = code === last && now - lastSeen < windowMs;
      last = code;
      lastSeen = now;
      return !repeat;
    },
    reset() {
      last = null;
      lastSeen = -Infinity;
    },
  };
}

/* ---------- 읽기 엔진 ---------- */

export interface Detector {
  engine: "native" | "zxing";
  /** 비디오의 지금 화면에서 바코드 원문을 읽는다 */
  detect(video: HTMLVideoElement): Promise<string[]>;
}

const NATIVE_FORMATS = ["ean_13", "ean_8", "code_128"];

async function nativeDetector(): Promise<Detector | null> {
  const BD = window.BarcodeDetector;
  if (!BD) return null;
  try {
    const supported = (await BD.getSupportedFormats?.()) ?? NATIVE_FORMATS;
    const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
    if (!formats.includes("ean_13")) return null;
    const det = new BD({ formats });
    return {
      engine: "native",
      detect: async (video) => (await det.detect(video)).map((c) => c.rawValue),
    };
  } catch {
    return null;
  }
}

async function zxingDetector(): Promise<Detector> {
  // 바코드 화면을 열 때만 받는다 (첫 화면 번들에 넣지 않음). wasm도 우리 사이트에서 받는다.
  const [{ prepareZXingModule, readBarcodes }, { default: wasmUrl }] = await Promise.all([
    import("zxing-wasm/reader"),
    import("zxing-wasm/reader/zxing_reader.wasm?url"),
  ]);
  await prepareZXingModule({
    overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) },
    fireImmediately: true,
  });
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas");
  return {
    engine: "zxing",
    detect: async (video) => {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return [];
      const scale = Math.min(1, 1280 / Math.max(w, h));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const results = await readBarcodes(ctx.getImageData(0, 0, canvas.width, canvas.height), {
        formats: ["EAN13", "EAN8", "Code128"],
        tryHarder: true,
        maxNumberOfSymbols: 1,
      });
      return results.filter((r) => r.isValid).map((r) => r.text);
    },
  };
}

/** 쓸 수 있는 읽기 엔진을 고른다. 둘 다 안 되면 예외. */
export async function createDetector(): Promise<Detector> {
  return (await nativeDetector()) ?? (await zxingDetector());
}
