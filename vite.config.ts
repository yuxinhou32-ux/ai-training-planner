import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// §2.3：dev proxy 5173 -> 8787；构建产物出 dist/web（由 node 服务端静态托管）
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
