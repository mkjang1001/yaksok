import { useEffect, useState } from "react";

/** 해시 주소 라우터: #/result, #/detail/R2:..., #/camera?mode=barcode */
export interface Route {
  path: string;
  param: string | null;
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [pathPart, queryPart = ""] = raw.split("?");
  const segs = pathPart.split("/").filter(Boolean);
  return {
    path: "/" + (segs[0] ?? ""),
    param: segs.length > 1 ? decodeURIComponent(segs.slice(1).join("/")) : null,
    query: new URLSearchParams(queryPart),
  };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onChange = () => {
      setRoute(parse());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function go(to: string) {
  window.location.hash = to;
}

export function back(fallback = "/") {
  if (window.history.length > 1) window.history.back();
  else go(fallback);
}
