import { Header, HelperBanner, PillShape, SevChip, SpeakButton } from "../components/ui";
import { useStore } from "../store";

/** S08 판정 상세 */
export function Detail({ id }: { id: string | null }) {
  const { result, meds } = useStore();
  const f = result?.findings.find((x) => x.id === id);
  if (!f) {
    return (
      <div className="screen">
        <Header title="자세히" backTo="/result" />
        <main className="body"><p className="card">이 항목을 찾지 못했어요. 결과 화면으로 돌아가 주세요.</p></main>
      </div>
    );
  }
  const involved = f.items.map((seq, i) => ({ med: meds.find((m) => m.item_seq === seq), label: f.item_labels[i] }));
  return (
    <div className="screen">
      <HelperBanner />
      <Header backLabel="결과로" backTo="/result" />
      <main className="body">
        <SevChip severity={f.severity} />
        <h2 className="h1">{f.title}</h2>

        {involved.length > 0 && (
          <div className={`pair ${involved.length === 1 ? "pair-one" : ""}`}>
            {involved.map(({ med, label }, i) => (
              <div key={i} className="pair-item">
                <PillShape pill={med?.pill ?? null} size={1.2} />
                <b>{label}</b>
                <span className="muted small">{med?.name}</span>
              </div>
            ))}
          </div>
        )}

        <section className="stack-sm">
          <h3 className="label">무슨 뜻인가요?</h3>
          <p className="lead">{f.body}</p>
        </section>

        {f.question && (
          <section className="ask">
            <h3 className="label accent">약사님께 이렇게 물어보세요</h3>
            <p className="ask-text">"{f.question}"</p>
            <span className="accent small">출력물에 들어가요</span>
          </section>
        )}

        <details className="evidence">
          <summary>근거 보기</summary>
          <dl>
            <dt>규칙</dt><dd>{f.rule}{f.group ? ` · ${f.group}` : ""}</dd>
            {f.ingredients.length > 0 && (<><dt>성분</dt><dd>{f.ingredients.join(", ")}</dd></>)}
            <dt>근거</dt><dd>{f.evidence.source ?? "-"}{f.evidence.detail ? ` · ${f.evidence.detail}` : ""}</dd>
            <dt>기준일</dt><dd>{f.evidence.data_date ?? result?.data_date ?? "-"} · 규칙 버전 {result?.rule_version}</dd>
            <dt>문구 감수</dt><dd>{f.template.approved ? `승인됨 (v${f.template.version})` : "감수 전"}</dd>
          </dl>
        </details>
      </main>
      <footer className="footer">
        <SpeakButton text={[f.title, f.body]} label="소리로 듣기" wide />
      </footer>
    </div>
  );
}
