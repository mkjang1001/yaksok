import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initInstall, useOnline } from "./lib/install";
import { StoreProvider } from "./store";
import "./styles.css";

initInstall();

/** 인터넷이 끊기면 모든 화면 맨 위에 알린다 */
function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <p className="offline-banner" role="status">
      인터넷이 끊겼어요. 넣어 둔 약은 그대로 점검할 수 있어요.
    </p>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoreProvider>
      <OfflineBanner />
      <App />
    </StoreProvider>
  </StrictMode>,
);
