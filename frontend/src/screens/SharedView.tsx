import { useEffect, useState, type ReactNode } from "react";
import { Disclaimer, Header, PillShape, SampleNotice, SevChip, SpeakButton } from "../components/ui";
import { api } from "../lib/api";
import { drugData } from "../lib/data";
import { decodeShare, isLocked, isValidPin, ShareError, type SharePayload } from "../lib/share";
import { medFromDrug, useStore } from "../store";
import type { CheckResult, Med } from "../types";

const AGE_LABEL = { "65+": "65세 이상", under65: "65세 미만" } as const;

type State =
  | { step: "pin"; error: string | null; busy: boolean }
  | { step: "loading" }
  | { step: "error"; message: string; retry: boolean }
  | { step: "done"; payload: SharePayload; meds: Med[]; result: CheckResult };

/** 받은 링크 보기 (#/shared/<데이터>) — 읽기 전용. 내 목록에 넣는 것은 확인한 뒤에만, 합쳐서 넣는다. */
export function SharedView({ data }: { data: string | null }) {
  const { profile } = useStore();
  const [state, setState] = useState<State>({ step: "loading" });
  const [pin, setPin] = useState("");
  const [attempt, setAttempt] = useState(0);

  const open = async (code?: string) => {
    try {
      const payload = await decodeShare(data ?? "", code);
      setState({ step: "loading" });
      const meds = await toMeds(payload);
      const result = await api.check({ ...profile, ageBand: payload.ageBand }, meds);
      setState({ step: "done", payload, meds, result });
    } catch (e) {
      if (e instanceof ShareError && e.code === "wrong-pin") setState({ step: "pin", error: e.message, busy: false });
      else setState({ step: "error", message: e instanceof Error ? e.message : "링크를 열지 못했어요.", retry: !(e instanceof ShareError) });
    }
  };

  useEffect(() => {
    let locked: boolean;
    try {
      locked = isLocked(data ?? "");
    } catch (e) {
      setState({ step: "error", message: (e as Error).message, retry: false });
      return;
    }
    if (locked) setState({ step: "pin", error: null, busy: false });
    else open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const header = <Header title="받은 약 목록" backLabel="처음으로" backTo="/" />;

  if (state.step === "loading") {
    return <div className="screen">{header}<main className="body"><p className="loading" role="status">받은 약 목록을 살펴보는 중이에요…</p></main></div>;
  }

  if (state.step === "error") {
    return (
      <div className="screen">
        {header}
        <main className="body">
          <p className="error" role="alert">{state.message}</p>
          {state.retry && <button type="button" className="btn btn-primary" onClick={() => setAttempt(attempt + 1)}>다시 열기</button>}
          <a className="btn btn-outline" href="#/">처음으로</a>
        </main>
      </div>
    );
  }

  if (state.step === "pin") {
    const submit = () => {
      setState({ step: "pin", error: null, busy: true });
      open(pin);
    };
    return (
      <div className="screen">
        {header}
        <main className="body">
          <div className="stack-sm">
            <h2 className="h2">숫자로 잠긴 목록이에요</h2>
            <p className="muted-strong">보내 준 분께 들은 숫자 4자리를 넣어 주세요.</p>
          </div>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); if (isValidPin(pin) && !state.busy) submit(); }}>
            <div className="field">
              <label htmlFor="shared-pin" className="field-label">숫자 4자리</label>
              <input id="shared-pin" className="input share-pin" type="text" inputMode="numeric" autoComplete="off"
                pattern="[0-9]*" maxLength={4} value={pin} autoFocus
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} />
            </div>
            {state.error && <p className="error" role="alert">{state.error}</p>}
            <button type="submit" className="btn btn-primary" disabled={!isValidPin(pin) || state.busy}>
              {state.busy ? "여는 중…" : "열기"}
            </button>
          </form>
        </main>
      </div>
    );
  }

  return <SharedResult payload={state.payload} meds={state.meds} result={state.result} header={header} />;
}

/** 받은 목록을 화면·가져오기에 쓸 약 모양으로 바꾼다. 코드가 있는 약은 약 정보를 받아 이름·성분을 채운다. */
async function toMeds(p: SharePayload): Promise<Med[]> {
  const seqs = p.meds.map((m) => m.item_seq).filter((s): s is string => !!s);
  const drugs = seqs.length ? await drugData.drugs(seqs) : {};
  return p.meds.map((m) => {
    const d = m.item_seq ? drugs[m.item_seq] : undefined;
    if (d) return medFromDrug(d, "search", m.received_from);
    return {
      id: crypto.randomUUID(),
      item_seq: m.item_seq,
      name: m.item_seq ? `알 수 없는 약 (품목코드 ${m.item_seq})` : m.name,
      category: null, pill: null, ingredients: [],
      received_from: m.received_from,
      source: "manual",
      added_at: new Date().toISOString(),
    };
  });
}

function SharedResult({ payload, meds, result, header }: { payload: SharePayload; meds: Med[]; result: CheckResult; header: ReactNode }) {
  const { meds: mine, addMeds } = useStore();
  const [asking, setAsking] = useState(false);
  const [added, setAdded] = useState<number | null>(null);

  // 이미 내 목록에 있는 약(같은 품목코드, 또는 코드 없는 약은 같은 이름·받은 곳)은 빼고 더한다
  const fresh = meds.filter((m) => !mine.some((x) =>
    m.item_seq ? x.item_seq === m.item_seq : !x.item_seq && x.name === m.name && x.received_from === m.received_from));

  const doImport = () => {
    addMeds(fresh);
    setAdded(fresh.length);
    setAsking(false);
  };

  return (
    <div className="screen">
      {header}
      <p className="share-banner">가족이 보낸 목록을 보고 있어요 · 보기만 할 수 있어요</p>
      <Disclaimer />
      <main className="body">
        <SampleNotice dataset={result.dataset} />
        <div className="stack-sm">
          <h2 className="h2">약 <span className="accent">{meds.length}개</span> · {AGE_LABEL[payload.ageBand]}</h2>
          <span className="muted">이 기기에서 다시 점검한 결과예요.</span>
        </div>

        <div className="summary">
          {(["red", "amber", "grey"] as const).map((sev) => (
            <div key={sev} className={`summary-cell summary-${sev}`}>
              <span className="summary-num"><i aria-hidden="true" />{result.counts[sev]}</span>
              <span>{{ red: "꼭 확인", amber: "물어보기", grey: "참고" }[sev]}</span>
            </div>
          ))}
        </div>

        {result.findings.length === 0 && (
          <div className="card">
            <b className="card-title">확인된 주의 사항이 없습니다</b>
            <span className="muted">그래도 궁금한 점은 약사·의사에게 물어보세요.</span>
          </div>
        )}

        {result.findings.map((f) => (
          <article key={f.id} className={`finding finding-${f.severity}`}>
            <SevChip severity={f.severity} />
            <h3 className="finding-title">{f.title}</h3>
            <p className="finding-body">{f.body}</p>
            {f.question && <p className="ask-text">물어볼 것: {f.question}</p>}
            <SpeakButton text={f.tts_text} />
          </article>
        ))}

        {result.unchecked.length > 0 && (
          <div className="card card-dashed">
            <b className="card-title">점검하지 못한 약 {result.unchecked.length}개</b>
            <span className="muted-strong">{result.unchecked.map((u) => u.display_name).join(", ")}</span>
          </div>
        )}

        <section className="stack-sm" aria-label="받은 약 목록">
          <h3 className="group-title">받은 약 목록</h3>
          {meds.map((m) => (
            <div key={m.id} className="card">
              <div className="row">
                <PillShape pill={m.pill} />
                <div className="col">
                  <b className="drug-name">{m.category ?? m.name}</b>
                  <span className="muted">{m.category ? m.name : "목록에 없는 약"} · {m.received_from || "받은 곳 모름"}</span>
                </div>
              </div>
            </div>
          ))}
        </section>

        <p className="fine">데이터 기준일 {result.data_date ?? "-"} · 규칙 버전 {result.rule_version}</p>

        {added !== null ? (
          <div className="stack-sm">
            <p className="toast" role="status">
              {added > 0 ? `내 목록에 ${added}개를 더했어요.` : "모두 이미 내 목록에 있는 약이에요."}
            </p>
            <a className="btn btn-primary" href="#/list">내 약 목록 보기</a>
          </div>
        ) : asking ? (
          <div className="card share-confirm" role="alertdialog" aria-labelledby="share-confirm-title">
            <b id="share-confirm-title" className="card-title">이 기기의 내 약 목록에 더할까요?</b>
            <span className="muted-strong">
              {fresh.length > 0
                ? `새로운 약 ${fresh.length}개를 더해요. 지금 있는 약은 지우거나 바꾸지 않아요.`
                : "받은 약이 모두 이미 내 목록에 있어요."}
              {fresh.length < meds.length && fresh.length > 0 && ` 이미 있는 ${meds.length - fresh.length}개는 빼고 더해요.`}
            </span>
            <div className="row-2">
              <button type="button" className="btn btn-primary" onClick={doImport} disabled={fresh.length === 0}>더하기</button>
              <button type="button" className="btn btn-outline" onClick={() => setAsking(false)}>취소</button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-outline" onClick={() => setAsking(true)}>내 목록으로 가져오기</button>
        )}
      </main>
    </div>
  );
}
