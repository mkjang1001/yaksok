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

        <div className="grow" />
        <a className="btn btn-primary" href="#/">다 됐어요</a>
      </main>
    </div>
  );
}
