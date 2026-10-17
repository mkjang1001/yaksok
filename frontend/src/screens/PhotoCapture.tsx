import { useRef, useState } from "react";
import { Header, HelperBanner, Icon, Svg } from "../components/ui";
import { api, ApiError, ImageCheckError, OCR_MSG, shrinkImage } from "../lib/api";
import { go } from "../router";
import { useStore } from "../store";

/** 사진 처리 동의. 설정 화면의 "동의 철회"는 이 키를 지운다. */
export const PHOTO_CONSENT_KEY = "yaksok.photoConsent";
type Consent = "granted" | "denied" | null;

function readConsent(): Consent {
  try {
    const v = localStorage.getItem(PHOTO_CONSENT_KEY);
    return v === "granted" || v === "denied" ? v : null;
  } catch {
    return null;
  }
}

function writeConsent(v: Exclude<Consent, null>) {
  try {
    localStorage.setItem(PHOTO_CONSENT_KEY, v);
  } catch {
    // 저장이 안 되는 브라우저면 이번만 쓴다
  }
}

const PLACEHOLDER = "예)\n에소메프라졸정 20mg\n라베프라졸정 10mg";

/** S03 약 봉투 찍기 (사진 인식) — 인식 서버가 없거나 동의하지 않으면 봉투 글자 직접 입력 */
export function PhotoCapture() {
  const { setPendingOcr } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [consent, setConsent] = useState<Consent>(readConsent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [text, setText] = useState("");

  const decide = (v: Exclude<Consent, null>) => {
    writeConsent(v);
    setConsent(v);
    setError(null);
  };

  const finish = (lines: Awaited<ReturnType<typeof api.ocrText>>) => {
    if (lines.length === 0) {
      setError("약 이름을 찾지 못했어요. 봉투가 다 보이게 다시 찍거나, 약 이름을 직접 써 주세요.");
      setManual(true);
      return;
    }
    setPendingOcr(lines);
    go("/confirm");
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      finish(await api.ocrImage(await shrinkImage(file)));
    } catch (e) {
      if (e instanceof ImageCheckError) {
        // 다시 찍으면 되는 경우: 글자 입력으로 넘기지 않는다
        setError(e.message);
      } else {
        // 한도 초과(429)·서버 없음·인터넷 끊김·인식 실패 → 글자 직접 입력으로 안내
        setManual(true);
        setError(e instanceof ApiError ? e.message : OCR_MSG.failed);
      }
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onText = async () => {
    setBusy(true);
    setError(null);
    try {
      finish(await api.ocrText(text));
    } catch (e) {
      setError(e instanceof Error ? e.message : "글자를 읽지 못했어요.");
    } finally {
      setBusy(false);
    }
  };

  const textForm = (
    <>
      <label htmlFor="bag-text" className="field-label">봉투에 적힌 약 이름 (한 줄에 하나씩)</label>
      <textarea id="bag-text" className="input textarea" rows={5} value={text} onChange={(e) => setText(e.target.value)}
        placeholder={PLACEHOLDER} />
      <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={onText}>
        {busy ? "찾는 중…" : "이 글자로 약 찾기"}
      </button>
    </>
  );

  // 사진 인식 서버가 없거나, 사진을 보내는 데 동의하지 않았을 때: 봉투를 보고 약 이름을 옮겨 쓴다
  if (!api.ocrAvailable || consent === "denied") {
    return (
      <div className="screen">
        <HelperBanner />
        <Header title="약 봉투 보고 쓰기" backTo="/add" />
        <main className="body">
          <div className="stack-sm">
            <h2 className="h2">봉투에 적힌 약 이름을 써 주세요</h2>
            <p className="muted-strong">한 줄에 하나씩 쓰면 돼요. 함량(mg)까지 쓰면 더 정확해요.</p>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          {textForm}
          <div className="grow" />
          {api.ocrAvailable && (
            <button type="button" className="btn btn-ghost" onClick={() => { try { localStorage.removeItem(PHOTO_CONSENT_KEY); } catch { /* 무시 */ } setConsent(null); }}>
              사진으로 찍을래요
            </button>
          )}
        </main>
      </div>
    );
  }

  if (consent === null) {
    return (
      <div className="screen">
        <HelperBanner />
        <Header title="약 봉투 찍기" backTo="/add" />
        <main className="body">
          <div className="stack-sm">
            <h2 className="h2">사진을 찍기 전에 알려 드려요</h2>
          </div>
          <div className="card" role="note">
            <p className="muted-strong">
              사진은 글자를 읽는 데만 쓰이고 저장되지 않아요.
              글자를 읽기 위해 Google 서비스로 잠깐 보내져요.
            </p>
            <p className="muted-strong">
              읽은 글자로 약을 찾는 일은 이 기기 안에서 해요. 내 약 목록은 밖으로 나가지 않아요.
            </p>
          </div>
          <p className="muted-strong">괜찮지 않으면 봉투를 보고 약 이름을 직접 써도 돼요.</p>
          <div className="grow" />
          <button type="button" className="btn btn-primary" onClick={() => decide("granted")}>네, 사진으로 할게요</button>
          <button type="button" className="btn btn-ghost" onClick={() => decide("denied")}>아니요, 글자로 쓸게요</button>
        </main>
      </div>
    );
  }

  return (
    <div className="screen screen-dark">
      <HelperBanner />
      <Header title="약 봉투 찍기" backTo="/add" />
      <main className="body">
        <p className="camera-hint">봉투나 처방전이 화면 안에<br />다 들어오게, 밝은 곳에서 찍어 주세요</p>
        <label className="viewfinder" htmlFor="bag-photo" aria-busy={busy}>
          <span className="viewfinder-frame" aria-hidden="true" />
          <Svg size={64}>{Icon.camera}</Svg>
          <span>{busy ? "읽는 중이에요…" : "여기를 눌러 사진 찍기"}</span>
        </label>
        <input ref={fileRef} id="bag-photo" className="visually-hidden" type="file" accept="image/jpeg,image/png,image/*"
          capture="environment" disabled={busy} onChange={(e) => onFile(e.target.files?.[0])} />
        {error && <p className="error" role="alert">{error}</p>}
        <details className="manual" open={manual}>
          <summary>사진 대신 봉투 글자를 직접 쓸게요</summary>
          {textForm}
        </details>
        <div className="grow" />
        <a className="btn btn-on-dark" href="#/search">이름으로 찾기</a>
      </main>
    </div>
  );
}
