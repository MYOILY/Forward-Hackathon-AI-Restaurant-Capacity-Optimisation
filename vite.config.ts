import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.TABLEWATCH_API_PORT ?? 8000;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  publicDir: false,
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: Number(process.env.TABLEWATCH_UI_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.TABLEWATCH_API_URL ?? `http://127.0.0.1:${apiPort}`,
        ws: true,
      },
    },
  },
});
