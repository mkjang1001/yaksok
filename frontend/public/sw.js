/*
 * 약속 서비스 워커 — 인터넷이 끊겨도 앱이 뜨고, 한 번 받은 약 정보는 다시 쓸 수 있게 한다.
 * 의존성 없이 직접 작성. 모든 경로는 이 파일 위치 기준 상대 경로라 /yaksok/ 같은 하위 주소에서도 동작한다.
 * 빌드할 때 vite.config.ts 의 swBuild 플러그인이 아래 두 자리표시를 채운다.
 * (개발 서버에서는 등록하지 않는다)
 */
const VERSION = "__BUILD_VERSION__";
const BUILD_ASSETS = "__BUILD_ASSETS__"; // 빌드 결과물 목록(JSON 배열 문자열)

const SHELL_CACHE = `yaksok-shell-${VERSION}`;
// 약 정보는 앱 버전과 상관없이 유지하고, data_date 가 바뀔 때만 비운다
const DATA_CACHE = "yaksok-data";

const BASE = new URL("./", self.location).href;
const SHELL_FILES = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "apple-touch-icon.png",
  "privacy.html",
  "terms.html",
  ...parseAssets(),
];

function parseAssets() {
  try {
    const list = JSON.parse(BUILD_ASSETS);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const abs = (path) => new URL(path, BASE).href;

/**
 * Cloudflare Pages 는 index.html·privacy.html 을 .html 없는 주소로 넘긴다(308).
 * 넘겨받은 응답을 그대로 담아 두면 오프라인에서 화면으로 보여 줄 때 브라우저가 막으므로, 내용만 새 응답으로 옮겨 담는다.
 */
async function unredirect(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 한 파일이 실패해도 나머지는 담아 둔다
      await Promise.all(
        SHELL_FILES.map((p) =>
          fetch(abs(p), { cache: "reload" })
            .then(async (res) => (res.ok ? cache.put(abs(p), await unredirect(res)) : undefined))
            .catch(() => undefined),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith("yaksok-shell-") && n !== SHELL_CACHE).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // 다른 주소(글꼴, 사진 인식 서버 등)와 앱 범위 밖 요청은 건드리지 않는다
  if (url.origin !== self.location.origin || !req.url.startsWith(BASE)) return;

  const path = req.url.slice(BASE.length).split(/[?#]/)[0];

  if (path === "data/meta.json") {
    event.respondWith(metaNetworkFirst(req));
  } else if (path.startsWith("data/")) {
    event.respondWith(staleWhileRevalidate(event, req));
  } else if (req.mode === "navigate") {
    event.respondWith(pageNetworkFirst(req, path));
  } else {
    event.respondWith(cacheFirst(req));
  }
});

/** 화면(html): 새 버전을 먼저 받아 보고, 끊겼으면 담아 둔 것을 보여 준다 */
async function pageNetworkFirst(req, path) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) unredirect(res.clone()).then((r) => cache.put(req, r)).catch(() => undefined);
    return res;
  } catch {
    const key = path === "" ? abs("./") : req.url.split(/[?#]/)[0];
    return (
      (await cache.match(key)) ||
      (await cache.match(abs("index.html"))) ||
      new Response("인터넷이 끊겼어요. 연결되면 다시 열어 주세요.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    );
  }
}

/** 빌드 파일(이름에 해시가 붙어 있음)·아이콘: 담아 둔 것을 먼저 쓴다 */
async function cacheFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

/** 약 정보 조각: 담아 둔 것을 바로 주고, 뒤에서 새로 받아 바꿔 둔다 */
async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(DATA_CACHE);
  const hit = await cache.match(req);
  const update = fetch(req)
    .then(async (res) => {
      if (res.ok) await cache.put(req, res.clone());
      return res;
    });
  if (hit) {
    event.waitUntil(update.catch(() => undefined));
    return hit;
  }
  return update;
}

/** meta.json: 항상 새로 받아 보고, 기준일(data_date)이 바뀌었으면 담아 둔 약 정보를 모두 비운다 */
async function metaNetworkFirst(req) {
  const cache = await caches.open(DATA_CACHE);
  const key = abs("data/meta.json");
  try {
    const res = await fetch(req, { cache: "no-cache" });
    if (!res.ok) return res;
    const fresh = await res.clone().json().catch(() => null);
    const old = await cache.match(key).then((r) => (r ? r.json() : null)).catch(() => null);
    if (fresh && old && fresh.data_date !== old.data_date) {
      await caches.delete(DATA_CACHE);
    }
    await (await caches.open(DATA_CACHE)).put(key, res.clone());
    return res;
  } catch {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw new TypeError("offline");
  }
}
