import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // 상대 경로로 빌드해서 GitHub Pages 하위 주소(/저장소이름/)에서도 그대로 동작하게 한다
  base: "./",
  plugins: [react()],
  // 폴더가 다른 경로로 연결(리다이렉트)된 Windows 환경에서도 빌드되도록 실제 경로로 바꾸지 않는다.
  resolve: { preserveSymlinks: true },
  server: { port: 5173 },
  preview: { port: 4173 },
});
