import { useEffect, useState } from "react";
import { Header, HelperBanner, Icon, PillShape, Svg } from "../components/ui";
import { PlacePicker } from "../components/PlacePicker";
import { api, type SearchResult } from "../lib/api";
import { normalize } from "../lib/hangul";
import { MIN_QUERY_CHARS } from "../lib/search";
import { go } from "../router";
import { medFromDrug, useStore } from "../store";
import type { Drug } from "../types";

/** S05 이름으로 찾기 — 검색어 앞 두 글자에 해당하는 목록 조각만 받는다 */
export function Search() {
  const { addMeds, meds } = useStore();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Drug | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  const [place, setPlace] = useState("");
  const tooShort = q.trim().length > 0 && [...normalize(q)].length < MIN_QUERY_CHARS;

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api.search(term).then(
        (r) => { if (!cancelled) { setResults(r); setError(null); } },
        (e) => { if (!cancelled) setError(e.message); },
      );
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  const pick = async (seq: string) => {
    setPicking(seq);
    try {
      setPicked(await api.drug(seq));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "약 정보를 받지 못했어요.");
    } finally {
      setPicking(null);
    }
  };

  if (picked || custom) {
    const name = picked?.name ?? q.trim();
    return (
      <div className="screen">
        <HelperBanner />
        <Header title="받은 곳" backLabel="다시 찾기" onBack={() => { setPicked(null); setCustom(false); }} />
        <main className="body">
          <div className="card row">
            <PillShape pill={picked?.pill ?? null} size={1.2} />
            <div className="col">
              <b className="drug-name">{name}</b>
              <span className="muted">{picked ? picked.category : "목록에 없는 약 · 점검하지 못해요"}</span>
            </div>
          </div>
          <PlacePicker value={place} onChange={setPlace} />
          <div className="grow" />
          <button type="button" className="btn btn-primary" onClick={() => {
            if (picked) addMeds([medFromDrug(picked, "search", place.trim())]);
            else addMeds([{
              id: crypto.randomUUID(), item_seq: null, name, category: null, pill: null, ingredients: [],
              received_from: place.trim(), source: "manual", added_at: new Date().toISOString(),
            }]);
            go("/list");
          }}>목록에 넣기</button>
        </main>
      </div>
    );
  }

  const have = new Set(meds.map((m) => m.item_seq));
  return (
    <div className="screen">
      <HelperBanner />
      <Header title="이름으로 찾기" backTo="/add" />
      <main className="body">
        <div className="field">
          <label htmlFor="drug-q" className="field-label">약 이름</label>
          <div className="search-box">
            <Svg>{Icon.search}</Svg>
            <input id="drug-q" type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="예: 에소메" autoComplete="off" />
          </div>
          <span className="muted">두 글자 이상 써 주세요. ㅇㅅㅁ처럼 첫 글자만 써도 찾아요.</span>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {q.trim() && !tooShort && <span className="muted">찾은 약 {results.length}개</span>}
        <div className="stack">
          {results.map((d) => (
            <div key={d.item_seq} className="card row">
              <PillShape pill={d.pill} />
              <div className="col">
                <b className="drug-name">{d.name}</b>
                <span className="muted">{d.category}{d.company ? ` · ${d.company}` : ""}</span>
              </div>
              {have.has(d.item_seq) ? (
                <span className="tag">넣음</span>
              ) : (
                <button type="button" className="btn btn-sm btn-primary btn-narrow" aria-label={`${d.name} 넣기`}
                  disabled={picking !== null} onClick={() => pick(d.item_seq)}>
                  {picking === d.item_seq ? "…" : "넣기"}
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="grow" />
        {q.trim().length >= 2 && !/^[ㄱ-ㅎ\s]+$/.test(q.trim()) && (
          <div className="tip-box">
            <b>찾는 약이 없나요?</b>
            <span>봉투에 적힌 글자를 그대로 써 보시거나, 약 상자 바코드를 찍어 보세요.</span>
            <button type="button" className="btn btn-sm btn-outline" onClick={() => setCustom(true)}>
              "{q.trim()}" 그대로 목록에 넣기
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
