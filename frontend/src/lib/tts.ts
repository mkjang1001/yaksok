/** 소리로 듣기 (Web Speech API). 지원하지 않는 기기에서는 조용히 아무것도 하지 않는다. */
const RATES = [0.8, 1, 1.2];

export const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;

export function speak(texts: string | string[], rateIndex: number) {
  if (!ttsSupported) return;
  window.speechSynthesis.cancel();
  for (const text of Array.isArray(texts) ? texts : [texts]) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ko-KR";
    u.rate = RATES[rateIndex] ?? 1;
    const voice = window.speechSynthesis.getVoices().find((v) => v.lang.startsWith("ko"));
    if (voice) u.voice = voice;
    window.speechSynthesis.speak(u);
  }
}

export function stopSpeaking() {
  if (ttsSupported) window.speechSynthesis.cancel();
}
