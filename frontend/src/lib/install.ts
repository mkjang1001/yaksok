/**
 * 오프라인 사용(서비스 워커)과 홈 화면 추가 안내.
 * initInstall()은 화면을 그리기 전에 한 번 불러서 beforeinstallprompt 를 놓치지 않게 한다.
 */
import { useSyncExternalStore } from "react";

const DISMISS_KEY = "yaksok.installDismissed";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallKind = "prompt" | "ios" | null;

let deferred: BeforeInstallPromptEvent | null = null;
let hidden = false; // 설치했거나 닫았으면 다시 보이지 않는다
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  const ua = navigator.userAgent;
  // 아이패드 최신 사파리는 Mac 으로 보이므로 터치 지원으로 구분한다
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

let started = false;
export function initInstall() {
  if (started) return;
  started = true;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // 브라우저 기본 안내 대신 우리 버튼으로 보여 준다
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    hidden = true;
    deferred = null;
    notify();
  });
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);

  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => undefined);
    });
  }
}

function installKind(): InstallKind {
  if (hidden || readDismissed() || isStandalone()) return null;
  if (deferred) return "prompt";
  if (isIos()) return "ios";
  return null;
}

/** 홈 화면 추가 안내를 보여 줄 방식. 보여 줄 필요가 없으면 null */
export function useInstallKind(): InstallKind {
  return useSyncExternalStore(subscribe, installKind);
}

export async function promptInstall() {
  const e = deferred;
  if (!e) return;
  deferred = null;
  await e.prompt();
  const { outcome } = await e.userChoice.catch(() => ({ outcome: "dismissed" as const }));
  if (outcome === "accepted") hidden = true;
  notify();
}

/** 한 번 닫으면 다시 보이지 않는다 */
export function dismissInstall() {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* 저장할 수 없는 환경이면 이번 화면에서만 숨긴다 */
  }
  hidden = true;
  notify();
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine);
}
