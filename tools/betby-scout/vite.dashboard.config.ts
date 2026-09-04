import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

// The dashboard is a local-only SPA. It talks to the Scout server on 8787
// (REST + WebSocket); nothing here is ever exposed publicly.
export default defineConfig({
  root: 'src/dashboard',
  plugins: [react(), tailwind()],
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: {
    outDir: '../../dist/dashboard',
    emptyOutDir: true,
  },
});
