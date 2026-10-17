import { useState } from "react";
import { Header, HelperBanner, PillShape } from "../components/ui";
import { PlacePicker } from "../components/PlacePicker";
import { api } from "../lib/api";
import { go } from "../router";
import { medFromDrug, useStore } from "../store";
import type { DrugSummary, OcrLine } from "../types";

const SURE = 0.9;

/** S04 인식 확인 — 사람이 하나씩 "맞아요"를 눌러야 목록에 들어간다 (설계서 B1-1). */
export function Confirm() {
  const { pendingOcr, setPendingOcr, addMeds } = useStore();
  const [chosen, setChosen] = useState<Record<number, string | null>>({});
  const [rejected, setRejected] = useState<Record<number, boolean>>({});
  const [place, setPlace] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!pendingOcr) {
    return (
      <div className="screen">
        <Header title="인식 확인" backTo="/add" />
        <main className="body">
          <p className="card">확인할 사진이 없어요. 약 봉투를 다시 찍어 주세요.</p>
          <a className="btn btn-primary" href="#/camera?mode=photo">약 봉투 찍기</a>
        </main>
      </div>
    );
  }

  const picks: DrugSummary[] = pendingOcr
    .map((l, i) => l.candidates.find((c) => c.item_seq === chosen[i]))
    .filter((d): d is DrugSummary => !!d);

  // 확인한 약의 상세(성분)만 이때 받는다
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const details = await Promise.all(picks.map((d) => api.drug(d.item_seq)));
      addMeds(details.map((d) => medFromDrug(d, "ocr", place.trim())));
      setPendingOcr(null);
      go("/list");
    } catch (e) {
      setError(e instanceof Error ? e.message : "약 정보를 받지 못했어요.");
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <HelperBanner />
      <Header backLabel="다시 찍기" backTo="/camera?mode=photo" />
      <main className="body">
        <div className="stack-sm">
          <h2 className="h2">약 {pendingOcr.length}개를 찾았어요</h2>
          <p className="muted-strong">사진과 같은 약인지 하나씩 확인해 주세요.</p>
        </div>
        {pendingOcr.map((line, i) => (
          <LineCard key={i} line={line} chosen={chosen[i] ?? null} rejected={!!rejected[i]}
            onChoose={(seq) => { setChosen({ ...chosen, [i]: seq }); setRejected({ ...rejected, [i]: false }); }}
            onReject={() => { setChosen({ ...chosen, [i]: null }); setRejected({ ...rejected, [i]: true }); }} />
        ))}
        <PlacePicker value={place} onChange={setPlace} id="ocr-place" />
        <div className="grow" />
        {error && <p className="error" role="alert">{error}</p>}
        <button type="button" className="btn btn-primary" disabled={picks.length === 0 || busy} onClick={save}>
          {busy ? "넣는 중…" : `목록에 넣기 (${picks.length}개)`}
        </button>
      </main>
    </div>
  );
}

function LineCard({ line, chosen, rejected, onChoose, onReject }: {
  line: OcrLine; chosen: string | null; rejected: boolean;
  onChoose: (seq: string) => void; onReject: () => void;
}) {
  const top = line.candidates[0];
  const sure = top.score !== undefined && top.score >= SURE && !rejected;

  if (sure) {
    const ok = chosen === top.item_seq;
    return (
      <div className={`card ${ok ? "card-ok" : ""}`}>
        <div className="row">
          <PillShape pill={top.pill} size={1.1} />
          <div className="col">
            <b className="drug-name">{top.name}</b>
            <span className="muted">{[top.category, `봉투 글자 "${line.line}"`].filter(Boolean).join(" · ")}</span>
          </div>
        </div>
        <div className="row-2">
          <button type="button" className={`btn btn-sm ${ok ? "btn-good" : "btn-outline"}`} aria-pressed={ok}
            onClick={() => onChoose(top.item_seq)}>✓ 맞아요</button>
          <button type="button" className="btn btn-sm btn-outline" onClick={onReject}>아니에요</button>
        </div>
      </div>
    );
  }

  return (
    <div className="card card-warn">
      <b className="warn-text">{rejected ? "그럼 이 중에 있나요?" : "글자가 흐려요. 이 중에 있나요?"}</b>
      <span className="muted">봉투 글자 "{line.line}"</span>
      {line.candidates.map((c) => (
        <button key={c.item_seq} type="button" className={`option ${chosen === c.item_seq ? "on" : ""}`}
          aria-pressed={chosen === c.item_seq} aria-label={[c.name, c.category || c.company].filter(Boolean).join(" ")} onClick={() => onChoose(c.item_seq)}>
          <PillShape pill={c.pill} size={0.8} />
          <span className="col"><b>{c.name}</b><span className="muted">{c.category || c.company}</span></span>
        </button>
      ))}
      <a className="link" href="#/search">없어요, 이름으로 찾을게요</a>
    </div>
  );
}
