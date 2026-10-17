import { Fragment, useEffect } from "react";
import { stopSpeaking } from "./lib/tts";
import { useRoute } from "./router";
import { AddMethod } from "./screens/AddMethod";
import { Camera } from "./screens/Camera";
import { Confirm } from "./screens/Confirm";
import { Detail } from "./screens/Detail";
import { Helper } from "./screens/Helper";
import { Home } from "./screens/Home";
import { MyList } from "./screens/MyList";
import { Print } from "./screens/Print";
import { Result } from "./screens/Result";
import { Search } from "./screens/Search";
import { Settings } from "./screens/Settings";
import { Share } from "./screens/Share";
import { SharedView } from "./screens/SharedView";
import { useStore } from "./store";

export function App() {
  const { ready } = useStore();
  const route = useRoute();

  useEffect(() => stopSpeaking, [route.path, route.param]);

  if (!ready) return <p className="loading" role="status">불러오는 중…</p>;

  // 주소가 바뀌면 화면을 새로 그려 이전 화면의 입력 상태가 남지 않게 한다
  return <Fragment key={`${route.path}/${route.param ?? ""}?${route.query}`}>{screen(route)}</Fragment>;
}

function screen(route: ReturnType<typeof useRoute>) {
  switch (route.path) {
    case "/add": return <AddMethod />;
    case "/camera": return <Camera mode={route.query.get("mode") === "barcode" ? "barcode" : "photo"} />;
    case "/confirm": return <Confirm />;
    case "/search": return <Search />;
    case "/list": return <MyList />;
    case "/result": return <Result />;
    case "/detail": return <Detail id={route.param} />;
    case "/print": return <Print />;
    case "/settings": return <Settings />;
    case "/share": return <Share />;
    case "/shared": return <SharedView data={route.param} />;
    case "/helper": return <Helper step={route.query.get("step")} />;
    default: return <Home />;
  }
}
