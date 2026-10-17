import { useEffect, useState } from "react";
import { Header } from "../components/ui";
import { api, type OrgStats } from "../lib/api";
import { go } from "../router";
import { medsKey, useStore } from "../store";

/** S11 도우미 모드 — 계정 없이 시작, 끝내면 기기의 약 목록을 지우고 익명 통계 1건만 이 기기에 쌓는다 */
export function Helper({ step }: { step: string | null }) {
  const store = useStore();
  const { helper, meds, result, resultKey, profile } = store;
  const [orgCode, setOrgCode] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orgStats, setOrgStats] = useState<OrgStats | undefined>();
  const ending = !!helper && step !== "start";

  useEffect(() => {
    if (helper) api.orgStats(helper.orgCode).then(setOrgStats);
  }, [helper]);

  if (!ending) {
    return (
      <div className="screen">
        <Header backTo="/" right={<span className="tag tag-accent">도우미 모드</span>} />
        <main className="body">
          <div className="stack-sm">
            <h2 className="h2">어르신 한 분 점검 시작</h2>
            <p className="muted-strong">이름과 연락처는 받지 않아요. 끝내면 이 기기의 약 목록이 지워져요.</p>
          </div>
          {meds.length > 0 && !helper && (
            <p className="error">이 기기에 이미 약 {meds.length}개가 있어요. 시작하면 지워져요.</p>
          )}
          <div className="field">
            <label htmlFor="org-code" className="field-label">기관 코드</label>
            <input id="org-code" className="input" value={orgCode} maxLength={40} autoComplete="off"
              onChange={(e) => setOrgCode(e.target.value)} placeholder="담당 사회복지사에게 받은 코드" />
          </div>
          <div className="tip-box">
            <b>어르신께 이렇게 말씀드리세요</b>
            <span>"드시는 약 봉투를 사진으로 찍어서 같이 드셔도 되는지 살펴볼게요. 이름은 적지 않고, 끝나면 사진과 목록은 지워져요. 괜찮으세요?"</span>
          </div>
          <label htmlFor="consent" className={`check-row ${consent ? "on" : ""}`}>
            <input id="consent" type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <b>설명드렸고, 괜찮다고 하셨어요</b>
          </label>
          <div className="grow" />
          <button type="button" className="btn btn-primary" disabled={!consent || !orgCode.trim()}
            onClick={() => { store.startHelper(orgCode.trim()); go("/add"); }}>
            {!orgCode.trim() ? "기관 코드를 넣어 주세요" : !consent ? "동의를 먼저 확인해 주세요" : "점검 시작"}
          </button>
        </main>
      </div>
    );
  }

  const fresh = result && resultKey === medsKey(meds, profile);
  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      if (fresh) {
        await api.stat({
          org_code: helper.orgCode,
          med_count: result.med_count,
          count_red: result.counts.red,
          count_amber: result.counts.amber,
          count_grey: result.counts.grey,
        });
      }
      store.endHelper();
      go("/");
    } catch (e) {
      setError((e instanceof Error ? e.message : "통계를 저장하지 못했어요.") + " 그래도 끝내려면 한 번 더 눌러 주세요.");
      setBusy(false);
      if (error) { store.endHelper(); go("/"); }
    }
  };

  return (
    <div className="screen">
      <Header backTo="/" right={<span className="tag tag-accent">도우미 모드</span>} />
      <main className="body">
        <div className="stack-sm">
          <h2 className="h2">점검을 끝낼까요?</h2>
          <p className="muted-strong">출력물을 어르신께 드렸는지 먼저 확인해 주세요.</p>
        </div>
        <div className="card card-danger">
          <b className="danger-text">이 기기에서 지워지는 것</b>
          <span>약 목록 {meds.length}개, 점검 결과</span>
        </div>
        <div className="card">
          <b>이 기기의 기관 통계에 더해지는 것</b>
          <span className="muted-strong">
            {fresh
              ? `점검 1건, 약 개수 ${result.med_count}, 꼭 확인 ${result.counts.red > 0 ? "있음" : "없음"}. 누구인지는 알 수 없어요.`
              : "점검을 하지 않아 통계는 남지 않아요."}
          </span>
          {orgStats && (
            <span className="muted">
              지금까지 기관 {helper.orgCode}: 점검 {orgStats.checks}건 · 약 {orgStats.meds}개 · 꼭 확인이 나온 점검 {orgStats.withRed}건
            </span>
          )}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="grow" />
        <div className="stack">
          <a className="btn btn-outline" href="#/print">출력물 다시 보기</a>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={finish}>지우고 끝내기</button>
        </div>
      </main>
    </div>
  );
}
