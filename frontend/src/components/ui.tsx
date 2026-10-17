import type { ReactNode } from "react";
import { back } from "../router";
import { speak } from "../lib/tts";
import { useStore } from "../store";
import type { Pill as PillT, Severity } from "../types";

export const Icon = {
  back: <path d="M15 5l-7 7 7 7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  camera: (
    <>
      <path d="M3.5 8h3.5l2-3h6l2 3h3.5v11.5h-17z" />
      <circle cx="12" cy="13.2" r="3.6" />
    </>
  ),
  barcode: <path d="M4 6v12M7 6v12M10.5 6v12M13 6v12M16.5 6v12M20 6v12" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5l5 5" />
    </>
  ),
  speaker: (
    <>
      <path d="M4 10v4h4l5 4V6L8 10z" />
      <path d="M16.5 9a4 4 0 010 6M19 6.5a7.5 7.5 0 010 11" />
    </>
  ),
  printer: (
    <>
      <path d="M7 9V4h10v5" />
      <rect x="4" y="9" width="16" height="7" rx="1.5" />
      <path d="M7 14h10v6H7z" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.6v.1" />
    </>
  ),
};

export function Svg({ children, size = 26 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.3}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="svg">
      {children}
    </svg>
  );
}

export function Header({ title, backLabel = "뒤로", backTo, onBack, right }: {
  title?: string; backLabel?: string | null; backTo?: string; onBack?: () => void; right?: ReactNode;
}) {
  return (
    <header className="topbar">
      {backLabel !== null && (
        <button type="button" className="back"
          onClick={() => (onBack ? onBack() : backTo ? (window.location.hash = backTo) : back())}>
          <Svg size={24}>{Icon.back}</Svg>
          {backLabel}
        </button>
      )}
      {title && <h1 className="topbar-title">{title}</h1>}
      <span className="spacer" />
      {right}
    </header>
  );
}

export function HelperBanner() {
  const { helper } = useStore();
  if (!helper) return null;
  return (
    <a className="helper-banner" href="#/helper?step=end">
      도우미 모드 · 기관 {helper.orgCode} <b>끝내기</b>
    </a>
  );
}

export function PillShape({ pill, size = 1 }: { pill: PillT | null; size?: number }) {
  const color = pill?.color ?? "#ffffff";
  const shape = pill?.shape ?? "oval";
  const w = (shape === "round" ? 22 : 32) * size;
  const h = (shape === "round" ? 22 : 18) * size;
  return (
    <span className="pill-box" aria-hidden="true">
      {pill?.image_url ? (
        <img src={pill.image_url} alt="" />
      ) : (
        <span className="pill" style={{ width: w, height: h, background: color, borderRadius: h / 2 }} />
      )}
    </span>
  );
}

const SEV_LABEL: Record<Severity, string> = { red: "꼭 확인하세요", amber: "물어보세요", grey: "참고하세요" };

export function SevChip({ severity }: { severity: Severity }) {
  return <span className={`sev sev-${severity}`}><i aria-hidden="true" />{SEV_LABEL[severity]}</span>;
}

export function SpeakButton({ text, label = "듣기", wide = false }: { text: string | string[]; label?: string; wide?: boolean }) {
  const { profile } = useStore();
  return (
    <button type="button" className={`btn btn-ghost ${wide ? "btn-wide" : ""}`} onClick={() => speak(text, profile.ttsRate)}>
      <Svg size={22}>{Icon.speaker}</Svg>
      {label}
    </button>
  );
}

export function Disclaimer() {
  return <p className="disclaimer">이 결과는 진단이 아닙니다. 약을 끊거나 바꾸기 전에 꼭 약사·의사와 상의하세요.</p>;
}

export function SampleNotice({ dataset }: { dataset: string | null | undefined }) {
  if (dataset !== "sample") return null;
  return <p className="sample-note">개발용 샘플 데이터입니다. 실제 의약품 정보가 아니니 실제 점검에 쓰지 마세요.</p>;
}
