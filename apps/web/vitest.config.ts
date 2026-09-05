import { defineConfig } from 'vitest/config';

// 不加载 @vitejs/plugin-react：vitest 2 内建 vite 5 类型与 vite 6 的插件类型冲突；
// JSX 转换由 esbuild 按 tsconfig 的 jsx: react-jsx 处理，测试无需 fast-refresh。
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
