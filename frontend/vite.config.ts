import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 빌드가 끝나면 dist/sw.js 의 자리표시를 채운다 (의존성 없이).
 * - __BUILD_VERSION__: 빌드마다 바뀌는 값 → 캐시 이름이 바뀌어 예전 앱 파일이 정리된다
 * - "__BUILD_ASSETS__": 설치할 때 미리 받아 둘 빌드 파일 목록
 */
function swBuild(): Plugin {
  let outDir = "dist";
  let assets: string[] = [];
  return {
    name: "yaksok-sw-build",
    apply: "build",
    configResolved(c) {
      outDir = c.build.outDir;
    },
    generateBundle(_, bundle) {
      assets = Object.keys(bundle).filter((f) => !f.endsWith(".map") && f !== "index.html");
    },
    writeBundle() {
      const file = join(outDir, "sw.js");
      const version = Date.now().toString(36);
      const src = readFileSync(file, "utf8")
        .replace("__BUILD_VERSION__", version)
        .replace('"__BUILD_ASSETS__"', JSON.stringify(JSON.stringify(assets)));
      writeFileSync(file, src);
    },
  };
}

export default defineConfig({
  // 상대 경로로 빌드해서 GitHub Pages 하위 주소(/저장소이름/)에서도 그대로 동작하게 한다
  base: "./",
  plugins: [react(), swBuild()],
  // 폴더가 다른 경로로 연결(리다이렉트)된 Windows 환경에서도 빌드되도록 실제 경로로 바꾸지 않는다.
  resolve: { preserveSymlinks: true },
  server: { port: 5173 },
  preview: { port: 4173 },
});
