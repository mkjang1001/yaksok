import { Header, HelperBanner, Icon, Svg } from "../components/ui";
import { api } from "../lib/api";

/** S02 약 추가 방법 */
export function AddMethod() {
  return (
    <div className="screen">
      <HelperBanner />
      <Header title="약 추가하기" backTo="/" />
      <main className="body">
        <h2 className="h2">어떤 걸 가지고 계세요?</h2>
        <a className="method method-main" href="#/camera?mode=photo">
          <span className="method-icon"><Svg size={34}>{Icon.camera}</Svg></span>
          <span className="method-text">
            <b>{api.ocrAvailable ? "약 봉투 찍기" : "약 봉투 보고 쓰기"}</b>
            <span>병원·약국에서 받은 봉투나 처방전</span>
          </span>
        </a>
        <a className="method" href="#/camera?mode=barcode">
          <span className="method-icon"><Svg size={34}>{Icon.barcode}</Svg></span>
          <span className="method-text"><b>약 상자 바코드</b><span>약국에서 직접 산 감기약·진통제</span></span>
        </a>
        <a className="method" href="#/search">
          <span className="method-icon"><Svg size={34}>{Icon.search}</Svg></span>
          <span className="method-text"><b>이름으로 찾기</b><span>봉투가 없을 때 약 이름을 써서</span></span>
        </a>
        <div className="grow" />
        <p className="tip"><Svg size={24}>{Icon.info}</Svg>파스, 영양제, 안약도 지금 쓰고 계시면 함께 넣어 주세요.</p>
      </main>
    </div>
  );
}
