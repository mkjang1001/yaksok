import { useRef, useState } from "react";
import { Header, HelperBanner, Icon, Svg } from "../components/ui";
import { api, ApiError, shrinkImage } from "../lib/api";
import { go } from "../router";
import { useStore } from "../store";

/** S03 약 봉투 찍기 (사진 인식) — 인식 서버가 없으면 봉투 글자 직접 입력 */
export function PhotoCapture() {
  const { setPendingOcr } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [text, setText] = useState("");

  const finish = (lines: Awaited<ReturnType<typeof api.ocrText>>) => {
    if (lines.length === 0) {
      setError("약 이름을 찾지 못했어요. 봉투가 다 보이게 다시 찍거나, 이름으로 찾아 주세요.");
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
      if (e instanceof ApiError && e.status === 503) {
        setManual(true);
        setError("사진 인식이 아직 연결되지 않았어요. 봉투에 적힌 약 이름을 아래에 써 주세요.");
      } else {
        setError(e instanceof Error ? e.message : "사진을 읽지 못했어요.");
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

  if (!api.ocrAvailable) {
    // 사진 인식 서버가 없을 때: 봉투를 보고 약 이름을 옮겨 쓴다
    return (
      <div className="screen">
        <HelperBanner />
        <Header title="약 봉투 보고 쓰기" backTo="/add" />
        <main className="body">
          <div className="stack-sm">
            <h2 className="h2">봉투에 적힌 약 이름을 써 주세요</h2>
            <p className="muted-strong">한 줄에 하나씩 쓰면 돼요. 함량(mg)까지 쓰면 더 정확해요.</p>
          </div>
          <label htmlFor="bag-text" className="field-label">약 이름</label>
          <textarea id="bag-text" className="input textarea" rows={5} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={"예)\n에소메프라졸정 20mg\n라베프라졸정 10mg"} />
          {error && <p className="error" role="alert">{error}</p>}
          <div className="grow" />
          <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={onText}>
            {busy ? "찾는 중…" : "이 글자로 약 찾기"}
          </button>
        </main>
      </div>
    );
  }

  return (
    <div className="screen screen-dark">
      <HelperBanner />
      <Header title="약 봉투 찍기" backTo="/add" />
      <main className="body">
        <p className="camera-hint">봉투가 화면 안에<br />다 들어오게 찍어 주세요</p>
        <label className="viewfinder" htmlFor="bag-photo">
          <span className="viewfinder-frame" aria-hidden="true" />
          <Svg size={64}>{Icon.camera}</Svg>
          <span>{busy ? "읽는 중이에요…" : "여기를 눌러 사진 찍기"}</span>
        </label>
        <input ref={fileRef} id="bag-photo" className="visually-hidden" type="file" accept="image/*" capture="environment"
          disabled={busy} onChange={(e) => onFile(e.target.files?.[0])} />
        {error && <p className="error" role="alert">{error}</p>}
        {(manual || !error) && (
          <details className="manual" open={manual}>
            <summary>사진 대신 봉투 글자를 직접 쓸게요</summary>
            <label htmlFor="bag-text" className="field-label">봉투에 적힌 약 이름 (한 줄에 하나씩)</label>
            <textarea id="bag-text" className="input textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)}
              placeholder={"예)\n에소메프라졸정 20mg\n라베프라졸정 10mg"} />
            <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={onText}>
              {busy ? "찾는 중…" : "이 글자로 약 찾기"}
            </button>
          </details>
        )}
        <div className="grow" />
        <a className="btn btn-on-dark" href="#/search">이름으로 찾기</a>
      </main>
    </div>
  );
}
