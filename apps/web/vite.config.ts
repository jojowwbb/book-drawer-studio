import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiOrigin = process.env.PB_API_ORIGIN ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    // WEB_PORT 供 e2e 使用独立端口，避免与开发者手动启动的服务冲突
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': { target: apiOrigin, changeOrigin: true },
      '/assets': { target: apiOrigin, changeOrigin: true },
    },
  },
  // @pb/renderer 是 workspace 内的 TS 源码包，不能进 esbuild 预打包缓存
  optimizeDeps: { exclude: ['@pb/renderer'] },
});
