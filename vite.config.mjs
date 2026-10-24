import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function localStamp() {
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome130' },
  server: { port: 5273, strictPort: true },
  // 构建时间打进包里，设置页会显示 —— 否则「我跑的是不是最新版」只能靠猜。
  // 应用常驻托盘，关掉窗口不等于退出，很容易一直在看旧窗口。
  define: {
    // 用本地时间：toISOString() 是 UTC，直接显示会差 8 小时，反而让人以为拿错了版本
    __BUILD_TIME__: JSON.stringify(localStamp())
  }
});
