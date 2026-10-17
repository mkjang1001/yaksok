import { BarcodeScan } from "./BarcodeScan";
import { PhotoCapture } from "./PhotoCapture";

/** S03 촬영 — 약 봉투(사진 인식) 또는 약 상자 바코드 */
export function Camera({ mode }: { mode: "photo" | "barcode" }) {
  return mode === "barcode" ? <BarcodeScan /> : <PhotoCapture />;
}
