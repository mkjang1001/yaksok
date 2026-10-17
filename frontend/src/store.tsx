import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { idb } from "./lib/idb";
import type { CheckResult, Drug, HelperSession, Med, OcrLine, Profile } from "./types";

interface Persisted {
  meds: Med[];
  profile: Profile;
  result: CheckResult | null;
  resultKey: string | null; // 결과를 낸 약 목록의 지문. 목록이 바뀌면 다시 점검한다
  checkedAt: string | null;
  helper: HelperSession | null;
}

const DEFAULTS: Persisted = {
  meds: [],
  profile: { ageBand: "65+", fontScale: 0, contrast: false, ttsRate: 1 },
  result: null,
  resultKey: null,
  checkedAt: null,
  helper: null,
};

const KEY = "app-v1";

export function medsKey(meds: Med[], profile: Profile) {
  return profile.ageBand + "|" + meds.map((m) => `${m.item_seq ?? m.name}@${m.received_from}`).join(",");
}

/**
 * 목록 카드 둘째 줄. 쉬운 분류가 있으면 큰 글씨가 분류라 약 이름을, 없으면(실제 공공데이터) 큰 글씨가 이름이라 성분을 보여 준다.
 * 품목코드가 없는 약(목록에 없는 약)은 null.
 */
export function medSubtitle(m: Med): string | null {
  if (!m.item_seq) return null;
  if (m.category) return m.name;
  return m.ingredients.join(", ");
}

export function medFromDrug(d: Drug, source: Med["source"], receivedFrom: string): Med {
  return {
    id: crypto.randomUUID(),
    item_seq: d.item_seq,
    name: d.name,
    category: d.category,
    pill: d.pill,
    ingredients: d.ingredients.map((i) => i.name),
    received_from: receivedFrom,
    source,
    added_at: new Date().toISOString(),
  };
}

interface Store extends Persisted {
  ready: boolean;
  /** 사진 인식 결과는 기기에도 저장하지 않고 메모리에만 둔다 */
  pendingOcr: OcrLine[] | null;
  setPendingOcr: (lines: OcrLine[] | null) => void;
  addMeds: (meds: Med[]) => void;
  updateMed: (id: string, patch: Partial<Med>) => void;
  removeMed: (id: string) => Med | undefined;
  restoreMed: (med: Med) => void;
  setProfile: (patch: Partial<Profile>) => void;
  setResult: (result: CheckResult, key: string) => void;
  startHelper: (orgCode: string) => void;
  /** 도우미 모드 종료: 이 기기의 약 목록·결과를 모두 지운다 */
  endHelper: () => void;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Persisted>(DEFAULTS);
  const [ready, setReady] = useState(false);
  const [pendingOcr, setPendingOcr] = useState<OcrLine[] | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    idb.get<Persisted>(KEY).then((saved) => {
      if (saved) setData({ ...DEFAULTS, ...saved, profile: { ...DEFAULTS.profile, ...saved.profile } });
      loaded.current = true;
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (loaded.current) idb.set(KEY, data);
  }, [data]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.scale = String(data.profile.fontScale);
    root.dataset.contrast = data.profile.contrast ? "high" : "normal";
  }, [data.profile.fontScale, data.profile.contrast]);

  const update = useCallback((fn: (d: Persisted) => Persisted) => setData((d) => fn(d)), []);

  const store = useMemo<Store>(
    () => ({
      ...data,
      ready,
      pendingOcr,
      setPendingOcr,
      addMeds: (meds) =>
        update((d) => {
          const existing = new Set(d.meds.map((m) => m.item_seq).filter(Boolean));
          const fresh = meds.filter((m) => !m.item_seq || !existing.has(m.item_seq));
          return { ...d, meds: [...d.meds, ...fresh] };
        }),
      updateMed: (id, patch) => update((d) => ({ ...d, meds: d.meds.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
      removeMed: (id) => {
        const target = data.meds.find((m) => m.id === id);
        update((d) => ({ ...d, meds: d.meds.filter((m) => m.id !== id) }));
        return target;
      },
      restoreMed: (med) => update((d) => ({ ...d, meds: [...d.meds, med] })),
      setProfile: (patch) => update((d) => ({ ...d, profile: { ...d.profile, ...patch } })),
      setResult: (result, key) => update((d) => ({ ...d, result, resultKey: key, checkedAt: new Date().toISOString() })),
      startHelper: (orgCode) =>
        update((d) => ({ ...d, meds: [], result: null, resultKey: null, checkedAt: null,
          helper: { orgCode, startedAt: new Date().toISOString() } })),
      endHelper: () => {
        setPendingOcr(null);
        update((d) => ({ ...d, meds: [], result: null, resultKey: null, checkedAt: null, helper: null }));
      },
    }),
    [data, ready, pendingOcr, update],
  );

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStore() {
  const s = useContext(Ctx);
  if (!s) throw new Error("StoreProvider가 필요합니다.");
  return s;
}
