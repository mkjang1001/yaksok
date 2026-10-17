import { useEffect, useRef, useState } from "react";
import { Header, HelperBanner, PillShape } from "../components/ui";
import { PHARMACY, PlacePicker } from "../components/PlacePicker";
import { api } from "../lib/api";
import { checkTypedCode, createDetector, createRepeatGuard, scannedToKey } from "../lib/barcode";
import { go } from "../router";
import { medFromDrug, useStore } from "../store";
import type { Drug } from "../types";

/** 이 시간 안에 바코드를 못 읽으면 숫자 입력으로 바꾼다 */
const READ_TIMEOUT_MS = 10_000;

type CamOff = "denied" | "none" | "engine" | "timeout" | "paused";

const OFF_MESSAGE: Record<CamOff, string> = {
  denied: "카메라 사용이 허락되지 않았어요. 바코드 아래 숫자를 써 주세요.",
  none: "카메라를 찾지 못했어요. 바코드 아래 숫자를 써 주세요.",
  engine: "이 기기에서는 바코드를 읽을 수 없어요. 바코드 아래 숫자를 써 주세요.",
  timeout: "바코드를 읽지 못했어요. 바코드 아래 숫자를 써 주세요.",
  paused: "카메라를 잠시 껐어요.",
};

const NOT_FOUND = "이 바코드의 약을 찾지 못했어요. 이름으로 찾아 주세요.";
const RECHECK = "숫자를 다시 확인해 주세요. 바코드 아래 숫자를 한 자리씩 그대로 써 주세요.";

/** S03 약 상자 바코드 — 카메라로 바코드를 계속 읽다가 보이면 바로 품목을 찾는다 */
export function BarcodeScan() {
  const { addMeds } = useStore();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<Drug | null>(null);
  const [place, setPlace] = useState(PHARMACY);
  const [scanOn, setScanOn] = useState(true);
  const [camLive, setCamLive] = useState(false);
  const [camOff, setCamOff] = useState<CamOff | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const guard = useRef(createRepeatGuard());
  /** "아니에요"라고 한 바코드는 카메라로 다시 찾지 않는다 */
  const rejected = useRef(new Set<string>());
  const foundCode = useRef<string | null>(null);

  /** 조회해서 찾으면 true. 못 찾으면 notFoundMsg 안내 */
  const lookup = async (value: string, notFoundMsg = NOT_FOUND) => {
    setBusy(true);
    setError(null);
    try {
      const drug = await api.barcode(value);
      foundCode.current = value;
      setFound(drug);
      return true;
    } catch (e) {
      const status = (e as { status?: number }).status;
      setError(status === 404 ? notFoundMsg : e instanceof Error ? e.message : NOT_FOUND);
      return false;
    } finally {
      setBusy(false);
    }
  };

  // 카메라: 화면을 계속 보여 주며 일정 간격으로 프레임을 읽는다. 화면을 떠나거나 찾으면 끈다.
  useEffect(() => {
    if (!scanOn || found) return;
    const video = videoRef.current;
    let stopped = false;
    let stream: MediaStream | null = null;
    let tickTimer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      stopped = true;
      clearTimeout(tickTimer);
      clearTimeout(deadline);
      stream?.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
      document.removeEventListener("visibilitychange", onHidden);
    };
    const turnOff = (why: CamOff) => {
      if (stopped) return;
      stop();
      setCamLive(false);
      setCamOff(why);
      setScanOn(false);
    };
    function onHidden() {
      if (document.visibilityState === "hidden") turnOff("paused");
    }
    document.addEventListener("visibilitychange", onHidden);

    (async () => {
      setCamOff(null);
      if (!video || !navigator.mediaDevices?.getUserMedia) return turnOff("none");
      const detectorP = createDetector(); // 카메라 권한을 묻는 동안 읽기 엔진도 같이 준비
      detectorP.catch(() => {});
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (e) {
        const name = (e as { name?: string }).name;
        return turnOff(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "none");
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      let detector: Awaited<typeof detectorP>;
      try {
        detector = await detectorP;
      } catch {
        return turnOff("engine");
      }
      if (stopped) return;
      video.srcObject = stream;
      await video.play().catch(() => {});
      if (stopped) return;
      setCamLive(true);
      deadline = setTimeout(() => turnOff("timeout"), READ_TIMEOUT_MS);
      const interval = detector.engine === "native" ? 200 : 350;

      const tick = async () => {
        if (stopped) return;
        if (video.readyState >= 2) {
          try {
            for (const raw of await detector.detect(video)) {
              const key = scannedToKey(raw);
              if (!key || stopped || rejected.current.has(key)) continue;
              clearTimeout(deadline); // 바코드는 읽혔으니 시간 제한은 끝
              if (!guard.current.shouldLookup(key, Date.now())) break;
              setCode(key);
              await lookup(key);
              break;
            }
          } catch {
            // 한 프레임 실패는 무시하고 다음 프레임을 읽는다
          }
        }
        if (!stopped) tickTimer = setTimeout(tick, interval);
      };
      tick();
    })();

    return () => {
      stop();
      setCamLive(false);
    };
  }, [scanOn, found]);

  const onTyped = async () => {
    const t = checkTypedCode(code);
    if (t.kind === "short") return;
    if (t.kind === "length") return setError(RECHECK);
    // 체크 숫자가 틀려도 약 DB에 있으면 그 약을 보여 준다(사람이 다시 확인). 없으면 숫자 확인 안내.
    await lookup(t.code, t.checksumOk ? NOT_FOUND : RECHECK);
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
            <button type="button" className="btn btn-outline"
              onClick={() => {
                if (foundCode.current) rejected.current.add(foundCode.current);
                setFound(null);
                setCode("");
              }}>
              아니에요
            </button>
          </div>
        </main>
      </div>
    );
  }

  const canRetry = camOff === "timeout" || camOff === "paused";

  return (
    <div className="screen">
      <HelperBanner />
      <Header title="약 상자 바코드" backTo="/add" />
      <main className="body">
        {scanOn && (
          <>
            <p className="camera-hint">상자의 줄무늬(바코드)를<br />노란 칸 안에 비춰 주세요</p>
            <div className="viewfinder" style={{ overflow: "hidden", cursor: "default" }}>
              <video ref={videoRef} muted playsInline autoPlay aria-label="카메라 화면"
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
              <span className="viewfinder-frame" aria-hidden="true" style={{ inset: "28% 1.2rem" }} />
              <span role="status" style={{ position: "relative" }}>
                {busy ? "찾는 중이에요…" : camLive ? "" : "카메라를 켜는 중이에요…"}
              </span>
            </div>
          </>
        )}
        {camOff && <p className={camOff === "paused" ? "muted-strong" : "error"} role="alert">{OFF_MESSAGE[camOff]}</p>}
        {canRetry && (
          <button type="button" className="btn btn-outline"
            onClick={() => { guard.current.reset(); setError(null); setScanOn(true); }}>
            카메라로 다시 비추기
          </button>
        )}
        <div className="field">
          <label htmlFor="barcode" className="field-label">
            {scanOn ? "또는 바코드 아래 숫자 쓰기" : "바코드 아래 숫자를 써 주세요"}
          </label>
          <input id="barcode" className="input" inputMode="numeric" value={code} maxLength={20}
            onChange={(e) => { setCode(e.target.value.replace(/\D/g, "")); setError(null); }}
            placeholder="예: 8800000000101" />
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="grow" />
        <button type="button" className="btn btn-primary" disabled={busy || code.length < 8} onClick={onTyped}>
          {busy ? "찾는 중…" : "약 찾기"}
        </button>
      </main>
    </div>
  );
}
