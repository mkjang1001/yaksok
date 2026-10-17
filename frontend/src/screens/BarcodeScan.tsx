import { useState } from "react";
import { Header, HelperBanner, Icon, PillShape, Svg } from "../components/ui";
import { PHARMACY, PlacePicker } from "../components/PlacePicker";
import { api } from "../lib/api";
import { go } from "../router";
import { medFromDrug, useStore } from "../store";
import type { Drug } from "../types";

declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats: string[] }) => { detect: (src: ImageBitmap) => Promise<{ rawValue: string }[]> };
  }
}

/** S03 약 상자 바코드 — 바코드를 읽어 품목을 찾는다 */
export function BarcodeScan() {
  const { addMeds } = useStore();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<Drug | null>(null);
  const [place, setPlace] = useState(PHARMACY);
  const canDetect = typeof window !== "undefined" && !!window.BarcodeDetector;

  const lookup = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      setFound(await api.barcode(value.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : "바코드를 찾지 못했어요.");
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file || !window.BarcodeDetector) return;
    setBusy(true);
    try {
      const bitmap = await createImageBitmap(file);
      const codes = await new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "code_128"] }).detect(bitmap);
      bitmap.close();
      if (codes[0]) {
        setCode(codes[0].rawValue);
        await lookup(codes[0].rawValue);
      } else {
        setError("바코드를 읽지 못했어요. 바코드 아래 숫자를 직접 써 주세요.");
      }
    } catch {
      setError("바코드를 읽지 못했어요. 바코드 아래 숫자를 직접 써 주세요.");
    } finally {
      setBusy(false);
    }
  };

  if (found) {
    return (
      <div className="screen">
        <HelperBanner />
        <Header title="약 상자 바코드" backTo="/add" />
        <main className="body">
          <h2 className="h2">이 약이 맞나요?</h2>
          <div className="card row">
            <PillShape pill={found.pill} size={1.2} />
            <div className="col"><b className="drug-name">{found.name}</b><span className="muted">{found.category}</span></div>
          </div>
          <PlacePicker value={place} onChange={setPlace} />
          <div className="grow" />
          <div className="stack">
            <button type="button" className="btn btn-primary"
              onClick={() => { addMeds([medFromDrug(found, "barcode", place.trim())]); go("/list"); }}>
              맞아요, 목록에 넣기
            </button>
            <button type="button" className="btn btn-outline" onClick={() => { setFound(null); setCode(""); }}>아니에요</button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="screen">
      <HelperBanner />
      <Header title="약 상자 바코드" backTo="/add" />
      <main className="body">
        {canDetect && (
          <>
            <label className="method method-main" htmlFor="box-photo">
              <span className="method-icon"><Svg size={34}>{Icon.barcode}</Svg></span>
              <span className="method-text"><b>바코드 찍기</b><span>상자의 줄무늬가 잘 보이게</span></span>
            </label>
            <input id="box-photo" className="visually-hidden" type="file" accept="image/*" capture="environment"
              onChange={(e) => onFile(e.target.files?.[0])} />
          </>
        )}
        <div className="field">
          <label htmlFor="barcode" className="field-label">
            {canDetect ? "또는 바코드 아래 숫자 쓰기" : "바코드 아래 숫자를 써 주세요"}
          </label>
          <input id="barcode" className="input" inputMode="numeric" value={code} maxLength={20}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="예: 8800000000101" />
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="grow" />
        <button type="button" className="btn btn-primary" disabled={busy || code.length < 8} onClick={() => lookup(code)}>
          {busy ? "찾는 중…" : "약 찾기"}
        </button>
      </main>
    </div>
  );
}
