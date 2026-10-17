import { useStore } from "../store";

export const PHARMACY = "약국에서 산 약";

/** "어디서 받으셨어요?" — 최근에 쓴 곳을 버튼으로 보여 주고, 직접 쓸 수도 있다. */
export function PlacePicker({ value, onChange, id = "place" }: { value: string; onChange: (v: string) => void; id?: string }) {
  const { meds } = useStore();
  const recent = Array.from(new Set(meds.map((m) => m.received_from).filter(Boolean)));
  const options = Array.from(new Set([...recent, PHARMACY])).slice(0, 5);
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">어디서 받으셨어요?</label>
      <div className="chips">
        {options.map((p) => (
          <button key={p} type="button" className={`chip ${value === p ? "on" : ""}`} aria-pressed={value === p}
            onClick={() => onChange(p)}>
            {p}
          </button>
        ))}
      </div>
      <input id={id} className="input" type="text" placeholder="예: OO내과" value={value} maxLength={50}
        onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
