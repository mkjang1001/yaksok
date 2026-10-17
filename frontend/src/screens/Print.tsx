import { Header, Icon, Svg } from "../components/ui";
import { medsKey, useStore } from "../store";

const MARK = { red: "●", amber: "◆", grey: "○" } as const;
const WORD = { red: "꼭 확인", amber: "물어보기", grey: "참고" } as const;

/** S09 출력물 (A4) — 흑백으로 인쇄해도 등급이 모양으로 구분된다 */
export function Print() {
  const { meds, result, resultKey, profile, checkedAt } = useStore();
  const ok = result && resultKey === medsKey(meds, profile);
  const date = checkedAt ? new Date(checkedAt) : new Date();
  const questions = ok ? result.findings.map((f) => f.question).filter((q): q is string => !!q) : [];

  return (
    <div className="screen screen-print">
      <div className="no-print">
        <Header title="출력 미리보기" backTo="/result" right={
          <button type="button" className="btn btn-sm btn-primary btn-narrow" onClick={() => window.print()}>
            <Svg size={22}>{Icon.printer}</Svg>인쇄
          </button>
        } />
        {!ok && <p className="error">점검 결과가 최신이 아니에요. 결과 화면에서 다시 점검한 뒤 출력해 주세요.</p>}
      </div>

      <article className="a4">
        <header className="a4-head">
          <div>
            <span className="a4-kicker">약속 · 내 약 목록</span>
            <h1>병원·약국에 가져가세요</h1>
          </div>
          <div className="a4-meta">
            <span>점검일 {date.getFullYear()}년 {date.getMonth() + 1}월 {date.getDate()}일</span>
            <span>이름 ____________ (직접 적으세요)</span>
          </div>
        </header>

        <section>
          <h2>1. 지금 드시는 약 ({meds.length}개)</h2>
          <table>
            <thead><tr><th>무슨 약</th><th>약 이름</th><th>성분</th><th>받은 곳</th></tr></thead>
            <tbody>
              {meds.map((m) => (
                <tr key={m.id}>
                  <td><b>{m.category || "-"}</b></td>
                  <td>{m.name}</td>
                  <td>{m.ingredients.join(", ") || "-"}</td>
                  <td>{m.received_from || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {ok && result.unchecked.length > 0 && (
            <p className="a4-small">점검하지 못한 것: {result.unchecked.map((u) => u.display_name).join(", ")}</p>
          )}
        </section>

        {ok && (
          <section>
            <h2>2. 확인할 것</h2>
            {result.findings.length === 0 && <p>확인된 주의 사항이 없습니다.</p>}
            {result.findings.map((f) => (
              <div key={f.id} className={`a4-finding a4-${f.severity}`}>
                <span className="a4-mark" aria-hidden="true">{MARK[f.severity]}</span>
                <div><b>{WORD[f.severity]} · {f.title}</b><p>{f.body}</p></div>
              </div>
            ))}
          </section>
        )}

        {questions.length > 0 && (
          <section>
            <h2>3. 약사·의사에게 물어볼 질문</h2>
            {questions.map((q, i) => <p key={i} className="a4-q"><span className="a4-box" aria-hidden="true" />{q}</p>)}
          </section>
        )}

        <section className="a4-memo">
          <h2>{questions.length > 0 ? 4 : 3}. 약사 메모</h2>
          <div className="a4-lines"><span /><span /><span /></div>
        </section>

        <footer className="a4-foot">
          <span>이 결과는 진단이 아닙니다. 약을 끊거나 바꾸기 전에 꼭 약사·의사와 상의하세요.
            {ok && result.dataset === "sample" && " (개발용 샘플 데이터로 만든 출력물입니다.)"}</span>
          <span>데이터 기준일 {ok ? result.data_date : "-"}<br />규칙 버전 {ok ? result.rule_version : "-"}</span>
        </footer>
      </article>
    </div>
  );
}
