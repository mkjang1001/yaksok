import { HelperBanner, Icon, PillShape, Svg } from "../components/ui";
import { medsKey, useStore } from "../store";

/** S01 홈 */
export function Home() {
  const { meds, result, resultKey, checkedAt, profile, helper } = useStore();
  const fresh = result && resultKey === medsKey(meds, profile);
  const date = checkedAt ? new Date(checkedAt) : null;
  return (
    <div className="screen">
      <HelperBanner />
      <header className="topbar">
        <span className="brand">약속</span>
        <span className="spacer" />
        <a className="btn-icon" href="#/settings" aria-label="글자 크기와 보기 설정">
          <span style={{ fontSize: "0.8rem" }}>가</span><span style={{ fontSize: "1.2rem" }}>가</span>
        </a>
      </header>
      <main className="body">
        <div className="stack-sm">
          <h2 className="hello">안녕하세요</h2>
          <p className="muted-strong">지금 드시는 약을 모아서<br />함께 먹어도 되는지 살펴 드려요.</p>
        </div>

        {meds.length > 0 ? (
          <a className="card card-link" href="#/list">
            <span className="muted">내 약 목록</span>
            <span className="big-count"><b>{meds.length}</b>개</span>
            <span className="pill-row">
              {meds.slice(0, 4).map((m) => <PillShape key={m.id} pill={m.pill} size={0.7} />)}
              {meds.length > 4 && <span className="muted">외 {meds.length - 4}개</span>}
            </span>
            {fresh && date && (
              <span className="muted">
                마지막 점검 {date.getMonth() + 1}월 {date.getDate()}일
                {result.counts.red > 0 && ` · 꼭 확인할 것 ${result.counts.red}개`}
              </span>
            )}
          </a>
        ) : (
          <div className="card">
            <span className="card-title">아직 넣은 약이 없어요</span>
            <span className="muted">약 봉투나 약 상자를 준비하시고 아래 "약 추가하기"를 눌러 주세요.</span>
          </div>
        )}

        <div className="grow" />

        <div className="stack">
          {meds.length > 0 && (
            <a className="btn btn-primary" href="#/result"><Svg>{Icon.check}</Svg>점검하기</a>
          )}
          <a className={`btn ${meds.length > 0 ? "btn-outline" : "btn-primary"}`} href="#/add">
            <Svg>{Icon.plus}</Svg>약 추가하기
          </a>
        </div>
        {!helper && <a className="link-center" href="#/helper">복지관 봉사자이신가요? 도우미 모드로 시작</a>}
      </main>
    </div>
  );
}
