/** 한글 처리 — backend/app/hangul.py 와 같은 규칙. */
export const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
const JONG = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ",
  "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const SYL_START = 0xac00;
const SYL_END = 0xd7a3;
const KEEP = /[^0-9a-z가-힣ㄱ-ㆎ]/g;
const DIGIT_BATCHIM: Record<string, boolean> = { "0": true, "1": true, "2": false, "3": true, "4": false,
  "5": false, "6": true, "7": true, "8": true, "9": false };
const UNIT_BATCHIM: [string, [boolean, boolean]][] = [["mcg", [true, false]], ["mg", [true, false]],
  ["ml", [true, true]], ["g", [true, false]]];

const isSyllable = (ch: string) => {
  const c = ch.codePointAt(0)!;
  return c >= SYL_START && c <= SYL_END;
};

export const normalize = (text: string) => text.toLowerCase().replace(KEEP, "");

export function decompose(text: string): string {
  let out = "";
  for (const ch of text) {
    if (isSyllable(ch)) {
      const code = ch.codePointAt(0)! - SYL_START;
      out += CHO[Math.floor(code / 588)] + JUNG[Math.floor((code % 588) / 28)] + JONG[code % 28];
    } else out += ch;
  }
  return out;
}

export function chosung(text: string): string {
  let out = "";
  for (const ch of text) out += isSyllable(ch) ? CHO[Math.floor((ch.codePointAt(0)! - SYL_START) / 588)] : ch;
  return out;
}

export const isChosungQuery = (text: string) => text.length > 0 && [...text].every((ch) => CHO.includes(ch));

function lastBatchim(word: string): [boolean, boolean] | null {
  const w = word.trim().toLowerCase();
  for (const [unit, info] of UNIT_BATCHIM) {
    if (w.endsWith(unit) && /\d$/.test(w.slice(0, -unit.length))) return info;
  }
  const chars = [...word.trim()].reverse();
  for (const ch of chars) {
    if (isSyllable(ch)) {
      const jong = (ch.codePointAt(0)! - SYL_START) % 28;
      return [jong !== 0, JONG[jong] === "ㄹ"];
    }
    if (ch in DIGIT_BATCHIM) return [DIGIT_BATCHIM[ch], "178".includes(ch)];
    if (/[a-z]/i.test(ch)) return [false, false];
  }
  return null;
}

/** 조사 붙이기. josa("진통제", "과", "와") → "진통제와" */
export function josa(word: string, withBatchim: string, withoutBatchim: string): string {
  const info = lastBatchim(word);
  if (!info) return `${word}${withBatchim}(${withoutBatchim})`;
  const [has, isRieul] = info;
  if (withBatchim === "으로" && isRieul) return word + "로";
  return word + (has ? withBatchim : withoutBatchim);
}

export function levenshtein(a: string, b: string): number {
  if (a.length < b.length) [a, b] = [b, a];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[b.length];
}

export const similarity = (a: string, b: string) =>
  !a && !b ? 1 : 1 - levenshtein(a, b) / Math.max(a.length, b.length);

/** target 안에서 query와 가장 비슷한 같은 길이 구간의 유사도 (오타 허용 부분 일치) */
export function bestWindowSimilarity(q: string, target: string): number {
  const n = q.length;
  if (n === 0) return 0;
  if (target.length <= n) return similarity(q, target);
  let best = 0;
  for (let s = 0; s + n <= target.length; s++) {
    best = Math.max(best, similarity(q, target.slice(s, s + n)));
    if (best === 1) break;
  }
  return best;
}
