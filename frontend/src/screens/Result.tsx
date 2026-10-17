import { useEffect, useState } from "react";
import { Disclaimer, Header, HelperBanner, Icon, SampleNotice, SevChip, SpeakButton, Svg } from "../components/ui";
import { api } from "../lib/api";
import { medsKey, useStore } from "../store";
import type { Severity } from "../types";

const SUMMARY: { sev: Severity; label: string }[] = [
  { sev: "red", label: "꼭 확인" },
  { sev: "amber", label: "물어보기" },
  { sev: "grey", label: "참고" },
];

/** S07 점검 결과 */
export function Result() {
  const { meds, profile, result, resultKey, setResult } = useStore();
  const key = medsKey(meds, profile);
  const stale = !result || resultKey !== key;
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!stale || meds.length === 0) return;
    let cancelled = false;
    setError(null);
    api.check(profile, meds).then(
      (r) => { if (!cancelled) setResult(r, key); },
      (e) => { if (!cancelled) setError(e.message); },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  if (meds.length === 0) {
    return (
      <div className="screen">
        <Header title="점검 결과" backTo="/" />
        <main className="body"><p className="card">점검할 약이 없어요. 먼저 약을 넣어 주세요.</p>
          <a className="btn btn-primary" href="#/add">약 추가하기</a></main>
      </div>
    );
  }

  if (stale || !result) {
    return (
      <div className="screen">
        <Header title="점검 결과" backLabel="내 약 목록" backTo="/list" />
        <main className="body">
          {error ? (
            <>
              <p className="error" role="alert">{error}</p>
              <button type="button" className="btn btn-primary" onClick={() => setAttempt(attempt + 1)}>다시 점검하기</button>
            </>
          ) : (
            <p className="loading" role="status">약 {meds.length}개를 살펴보는 중이에요…</p>
          )}
        </main>
      </div>
    );
  }

  const speechAll = [
    ...result.findings.map((f) => f.tts_text),
    ...(result.findings.length === 0 ? ["확인된 주의 사항이 없습니다."] : []),
  ];
  const unapproved = result.findings.some((f) => !f.template.approved);

  return (
    <div className="screen">
      <HelperBanner />
      <Header title="점검 결과" backLabel="내 약 목록" backTo="/list" />
      <Disclaimer />
      <main className="body">
        <SampleNotice dataset={result.dataset} />
        <div className="summary">
          {SUMMARY.map(({ sev, label }) => (
            <div key={sev} className={`summary-cell summary-${sev}`}>
              <span className="summary-num"><i aria-hidden="true" />{result.counts[sev]}</span>
              <span>{label}</span>
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
            {f.severity !== "grey" || f.question ? (
              <div className="row-2">
                <SpeakButton text={f.tts_text} />
                <a className={`btn btn-sm ${f.severity === "red" ? "btn-danger" : "btn-outline"}`}
                  href={`#/detail/${encodeURIComponent(f.id)}`}>자세히</a>
              </div>
            ) : null}
          </article>
        ))}

        {result.unchecked.length > 0 && (
          <div className="card card-dashed">
            <b className="card-title">점검하지 못한 약 {result.unchecked.length}개</b>
            <span className="muted-strong">
              {result.unchecked.map((u) => u.display_name).join(", ")}은(는) 정보를 찾지 못했어요. 약사님께 직접 보여 주세요.
            </span>
          </div>
        )}

        <a className="btn btn-outline" href="#/share">보호자에게 보내기</a>

        <p className="fine">
          데이터 기준일 {result.data_date ?? "-"} · 규칙 버전 {result.rule_version}
          {unapproved && " · 감수 전 문구 포함"}
        </p>
      </main>
      <footer className="footer row-2">
        <SpeakButton text={speechAll} label="모두 듣기" />
        <a className="btn btn-primary grow" href="#/print"><Svg>{Icon.printer}</Svg>출력하기</a>
      </footer>
    </div>
  );
}
