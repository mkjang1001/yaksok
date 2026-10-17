import { useState } from "react";
import { Header, HelperBanner, Icon, PillShape, Svg } from "../components/ui";
import { PlacePicker } from "../components/PlacePicker";
import { useStore } from "../store";
import type { Med } from "../types";

/** S06 내 약 목록 — 받은 곳별로 묶어서 보여 준다 */
export function MyList() {
  const { meds, updateMed, removeMed, restoreMed } = useStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [placeDraft, setPlaceDraft] = useState("");
  const [removed, setRemoved] = useState<Med | null>(null);

  const groups = new Map<string, Med[]>();
  for (const m of meds) {
    const key = m.received_from || "받은 곳 모름";
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }

  return (
    <div className="screen">
      <HelperBanner />
      <Header backLabel="처음으로" backTo="/" right={
        <a className="btn btn-sm btn-outline btn-narrow" href="#/add"><Svg size={20}>{Icon.plus}</Svg>약 추가</a>
      } />
      <main className="body">
        <div className="stack-sm">
          <h2 className="h2">내 약 <span className="accent">{meds.length}개</span></h2>
          {meds.length >= 5 && <span className="badge-grey"><i aria-hidden="true" />약이 5개 넘어요 · 다제약물</span>}
        </div>

        {removed && (
          <div className="toast" role="status">
            {removed.name}을(를) 뺐어요.
            <button type="button" className="link" onClick={() => { restoreMed(removed); setRemoved(null); }}>되돌리기</button>
          </div>
        )}

        {meds.length === 0 && <p className="card">아직 넣은 약이 없어요.</p>}

        {[...groups.entries()].map(([place, items]) => (
          <section key={place} className="stack-sm">
            <h3 className="group-title">{place} · {items.length}개</h3>
            {items.map((m) => (
              <div key={m.id} className="card">
                <div className="row">
                  <PillShape pill={m.pill} />
                  <div className="col">
                    <b className="drug-name">{m.category ?? m.name}</b>
                    <span className="muted">{m.category ? m.name : "목록에 없는 약 · 점검하지 못해요"}</span>
                  </div>
                </div>
                {editing === m.id ? (
                  <div className="stack-sm">
                    <PlacePicker value={placeDraft} onChange={setPlaceDraft} id={`place-${m.id}`} />
                    <div className="row-2">
                      <button type="button" className="btn btn-sm btn-primary"
                        onClick={() => { updateMed(m.id, { received_from: placeDraft.trim() }); setEditing(null); }}>저장</button>
                      <button type="button" className="btn btn-sm btn-outline" onClick={() => setEditing(null)}>취소</button>
                    </div>
                  </div>
                ) : (
                  <div className="row-2">
                    <button type="button" className="btn btn-sm btn-outline"
                      onClick={() => { setEditing(m.id); setPlaceDraft(m.received_from); }}>받은 곳 바꾸기</button>
                    <button type="button" className="btn btn-sm btn-outline"
                      onClick={() => { const r = removeMed(m.id); if (r) setRemoved(r); }}>빼기</button>
                  </div>
                )}
              </div>
            ))}
          </section>
        ))}
      </main>
      {meds.length > 0 && (
        <footer className="footer">
          <a className="btn btn-primary" href="#/result"><Svg>{Icon.check}</Svg>{meds.length}개 약 점검하기</a>
        </footer>
      )}
    </div>
  );
}
