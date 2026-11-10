import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 개발 중에는 /api 요청을 ASP.NET Core(5080)로 넘기고, 빌드 결과는 backend/wwwroot에 둔다.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../backend/wwwroot',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:5080', changeOrigin: true },
    },
  },
});
