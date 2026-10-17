import { useEffect, useMemo, useRef, useState } from "react";
import { Header, HelperBanner, Icon, Svg } from "../components/ui";
import { qrMatrix, qrSvgPath } from "../lib/qr";
import { encodeShare, isValidPin, payloadFromMeds, shareLink } from "../lib/share";
import { useStore } from "../store";

/** 보호자에게 보내기 — 약 목록을 링크 하나에 담는다. 서버에는 아무것도 저장하지 않는다. */
export function Share() {
  const { meds, profile } = useStore();
  const [lock, setLock] = useState(false);
  const [pin, setPin] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"ok" | "manual" | null>(null);
  const linkBox = useRef<HTMLTextAreaElement>(null);
  const ready = !lock || isValidPin(pin);

  useEffect(() => {
    setLink(null);
    setCopied(null);
    setError(null);
    if (meds.length === 0 || !ready) return;
    let cancelled = false;
    encodeShare(payloadFromMeds(meds, profile), lock ? pin : undefined).then(
      (data) => { if (!cancelled) setLink(shareLink(data)); },
      () => { if (!cancelled) setError("링크를 만들지 못했어요. 다시 해 주세요."); },
    );
    return () => { cancelled = true; };
  }, [meds, profile, lock, pin, ready]);

  const qr = useMemo(() => {
    const m = link ? qrMatrix(link) : null;
    return m ? qrSvgPath(m) : null;
  }, [link]);

  if (meds.length === 0) {
    return (
      <div className="screen">
        <Header title="보호자에게 보내기" backTo="/result" />
        <main className="body">
          <p className="card">보낼 약이 없어요. 먼저 약을 넣어 주세요.</p>
          <a className="btn btn-primary" href="#/add">약 추가하기</a>
        </main>
      </div>
    );
  }

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied("ok");
    } catch {
      linkBox.current?.focus();
      linkBox.current?.select();
      setCopied("manual");
    }
  };

  const shareSheet = async () => {
    if (!link) return;
    try {
      await navigator.share({ title: "약속 · 약 목록", text: "제가 먹는 약 목록이에요. 링크를 눌러 확인해 주세요.", url: link });
    } catch {
      // 사용자가 공유 창을 닫은 경우 — 아무것도 하지 않는다
    }
  };

  return (
    <div className="screen">
      <HelperBanner />
      <Header title="보호자에게 보내기" backLabel="점검 결과" backTo="/result" />
      <main className="body">
        <div className="stack-sm">
          <h2 className="h2">약 {meds.length}개를 링크로 보내요</h2>
          <p className="muted-strong">링크를 받은 가족·보호자는 같은 점검 결과를 볼 수 있어요.</p>
        </div>

        <div className="tip-box">
          <b>링크에 담기는 것</b>
          <span>약 이름(품목코드), 받은 곳, 나이대만 담겨요. 이름·전화번호 같은 개인 정보는 넣지 않아요.</span>
          <span>목록은 링크 주소 자체에 들어 있고, 어떤 서버에도 저장하지 않아요. 주소의 # 뒤 부분은 인터넷 주소 서버로 보내지지 않아 홈페이지 기록에도 남지 않아요.</span>
          <span>링크를 가진 사람은 누구나 목록을 볼 수 있으니 믿을 수 있는 분께만 보내 주세요.</span>
        </div>

        <div className="switch-row">
          <label htmlFor="share-lock" className="col">
            <b>숫자 4자리로 잠그기</b>
            <span className="muted">링크를 여는 사람이 숫자를 넣어야 볼 수 있어요.</span>
          </label>
          <button id="share-lock" type="button" role="switch" aria-checked={lock}
            className={`switch ${lock ? "on" : ""}`} onClick={() => setLock(!lock)}>
            <span />
          </button>
        </div>

        {lock && (
          <div className="field">
            <label htmlFor="share-pin" className="field-label">숫자 4자리</label>
            <input id="share-pin" className="input share-pin" type="text" inputMode="numeric" autoComplete="off"
              pattern="[0-9]*" maxLength={4} placeholder="예: 0427" value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} />
            <p className="muted">
              숫자 4자리는 링크만 보고는 내용을 알 수 없게 하는 정도예요. 마음먹고 풀려는 사람까지 막는 강한 보안은 아니에요.
              숫자는 링크와 따로, 전화로 알려 주세요.
            </p>
          </div>
        )}

        {error && <p className="error" role="alert">{error}</p>}
        {!ready && <p className="muted-strong">숫자 4자리를 넣으면 링크가 만들어져요.</p>}

        {link && (
          <section className="stack" aria-label="만든 링크">
            <label htmlFor="share-link" className="field-label">보낼 링크{lock && " (숫자로 잠김)"}</label>
            <textarea id="share-link" ref={linkBox} className="input textarea share-link" readOnly value={link}
              onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn btn-primary" onClick={copy}>
              <Svg>{Icon.check}</Svg>링크 복사하기
            </button>
            {copied === "ok" && <p className="toast" role="status">복사했어요. 문자나 카카오톡 대화창에 붙여 넣어 보내 주세요.</p>}
            {copied === "manual" && (
              <p className="error" role="status">자동으로 복사하지 못했어요. 위 링크 글자를 길게 눌러 복사해 주세요.</p>
            )}
            {typeof navigator.share === "function" && (
              <button type="button" className="btn btn-outline" onClick={shareSheet}>문자·카카오톡으로 보내기</button>
            )}

            {qr && (
              <div className="share-qr">
                <svg viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label="공유 링크 QR코드" shapeRendering="crispEdges">
                  <rect width={qr.size} height={qr.size} fill="#fff" />
                  <path d={qr.path} fill="#000" />
                </svg>
                <span className="muted">옆에 있는 가족은 휴대폰 카메라로 이 그림을 비추면 바로 열 수 있어요.</span>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
