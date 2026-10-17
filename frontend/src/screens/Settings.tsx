import { useState } from "react";
import { Header, SpeakButton } from "../components/ui";
import { ttsSupported } from "../lib/tts";
import { useStore } from "../store";
import type { Profile } from "../types";

/** S10 보기 설정 — 바꾸는 즉시 저장된다 */
export function Settings() {
  const { profile, setProfile } = useStore();
  return (
    <div className="screen">
      <Header title="보기 설정" backTo="/" />
      <main className="body">
        <fieldset className="field">
          <legend className="field-label">글자 크기</legend>
          <div className="seg">
            {(["기본", "크게", "아주 크게"] as const).map((label, i) => (
              <button key={label} type="button" className={`seg-btn seg-size-${i} ${profile.fontScale === i ? "on" : ""}`}
                aria-pressed={profile.fontScale === i} onClick={() => setProfile({ fontScale: i as Profile["fontScale"] })}>
                <span className="seg-big">가</span>{label}
              </button>
            ))}
          </div>
          <p className="preview">같은 성분이 두 약에 들어 있어요.</p>
        </fieldset>

        <div className="switch-row">
          <label htmlFor="contrast" className="col">
            <b>진하게 보기</b>
            <span className="muted">글자와 바탕을 더 또렷하게</span>
          </label>
          <button id="contrast" type="button" role="switch" aria-checked={profile.contrast}
            className={`switch ${profile.contrast ? "on" : ""}`} onClick={() => setProfile({ contrast: !profile.contrast })}>
            <span />
          </button>
        </div>

        <fieldset className="field">
          <legend className="field-label">읽어 주는 속도</legend>
          <div className="seg">
            {(["천천히", "보통", "빠르게"] as const).map((label, i) => (
              <button key={label} type="button" className={`seg-btn ${profile.ttsRate === i ? "on" : ""}`}
                aria-pressed={profile.ttsRate === i} onClick={() => setProfile({ ttsRate: i as Profile["ttsRate"] })}>
                {label}
              </button>
            ))}
          </div>
          {ttsSupported ? <SpeakButton text="이 속도로 읽어 드려요." label="들어 보기" wide />
            : <span className="muted">이 기기에서는 소리로 듣기를 쓸 수 없어요.</span>}
        </fieldset>

        <fieldset className="field">
          <legend className="field-label">나이</legend>
          <div className="seg seg-2">
            {([["65+", "65세 이상"], ["under65", "65세 미만"]] as const).map(([v, label]) => (
              <button key={v} type="button" className={`seg-btn ${profile.ageBand === v ? "on" : ""}`}
                aria-pressed={profile.ageBand === v} onClick={() => setProfile({ ageBand: v })}>
                {label}
              </button>
            ))}
          </div>
          <span className="muted">65세 이상이면 어르신께 주의가 필요한 약도 함께 살펴봐요.</span>
        </fieldset>

        <PrivacySection />

        <div className="grow" />
        <a className="btn btn-primary" href="#/">다 됐어요</a>
      </main>
    </div>
  );
}

const CONSENT_KEY = "yaksok.photoConsent";

function readConsent(): string | null {
  try {
    return localStorage.getItem(CONSENT_KEY);
  } catch {
    return null;
  }
}

/** 이 기기의 약 목록·설정·도우미 통계(IndexedDB 'yaksok')와 yaksok.* 저장값을 모두 지운다 */
async function eraseThisDevice() {
  for (const store of [localStorage, sessionStorage]) {
    try {
      Object.keys(store).filter((k) => k.startsWith("yaksok.")).forEach((k) => store.removeItem(k));
    } catch {
      /* 저장소를 쓸 수 없는 환경 */
    }
  }
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase("yaksok");
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** 개인정보와 이용 안내, 사진 처리 동의, 이 기기 정보 지우기 */
function PrivacySection() {
  const [consent, setConsent] = useState(readConsent);
  const [confirming, setConfirming] = useState(false);
  const [erasing, setErasing] = useState(false);

  const withdraw = () => {
    try {
      localStorage.removeItem(CONSENT_KEY);
    } catch {
      /* 무시 */
    }
    setConsent(readConsent());
  };

  const erase = async () => {
    setErasing(true);
    await eraseThisDevice();
    // 화면에 남은 내용까지 비우도록 처음 화면으로 새로 연다
    window.location.replace(window.location.pathname + window.location.search + "#/");
    window.location.reload();
  };

  return (
    <section className="settings-section" aria-labelledby="privacy-title">
      <h2 id="privacy-title" className="field-label">개인정보와 이용 안내</h2>
      <span className="muted">내 약 목록은 이 기기 안에만 저장되고, 서버에는 저장하지 않아요.</span>
      <div className="row-2">
        <a className="btn btn-ghost btn-sm" href="privacy.html">개인정보 처리방침</a>
        <a className="btn btn-ghost btn-sm" href="terms.html">이용 안내</a>
      </div>

      <div className="card">
        <span className="card-title">사진으로 약 넣기 동의</span>
        <span className="muted-strong">
          {consent === "granted" ? "동의하셨어요. 사진은 글자를 읽는 데만 쓰고 저장하지 않아요."
            : consent === "denied" ? "동의하지 않으셨어요. 사진 대신 이름 검색으로 넣을 수 있어요."
            : "아직 정하지 않으셨어요. 사진으로 약을 넣을 때 여쭤볼게요."}
        </span>
        {consent && (
          <button type="button" className="btn btn-outline btn-sm" onClick={withdraw}>
            {consent === "granted" ? "동의 철회하기" : "선택 지우기 (다음에 다시 묻기)"}
          </button>
        )}
      </div>

      <div className="card card-danger">
        <span className="card-title">이 기기의 내 정보 모두 지우기</span>
        <span className="muted">내 약 목록, 점검 결과, 보기 설정, 도우미 모드 기록, 사진 동의 선택이 모두 지워져요. 되돌릴 수 없어요.</span>
        {!confirming ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(true)}>모두 지우기</button>
        ) : (
          <div className="stack" role="alertdialog" aria-labelledby="erase-q">
            <b id="erase-q">정말 모두 지울까요?</b>
            <div className="row-2">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)} disabled={erasing}>그만두기</button>
              <button type="button" className="btn btn-danger btn-sm" onClick={erase} disabled={erasing}>
                {erasing ? "지우는 중…" : "네, 모두 지워요"}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
